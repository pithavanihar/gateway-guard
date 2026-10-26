import { createHmac, timingSafeEqual } from "node:crypto";
import { GatewayRequestError, InvalidSignatureError, ValidationError } from "../../errors.js";
import { fetchJson, type HttpDeps } from "../../http.js";
import type { Checkout, Outcome, PaymentMethod } from "../../types.js";
import type { CreateOrderInput, GatewayAdapter, StatusResult, WebhookEvent } from "../Adapter.js";
import { classifyCashfree } from "./classify.js";

// API reference (version 2023-08-01):
//   https://www.cashfree.com/docs/api-reference/payments/previous/v2023-08-01/orders/create
//   https://www.cashfree.com/docs/api-reference/payments/previous/v2023-08-01/payments/get-payments-for-order
//   https://www.cashfree.com/docs/api-reference/payments/previous/v2023-08-01/payments/webhooks
//   https://www.cashfree.com/docs/payments/online/webhooks/signature-verification
export const CASHFREE_API_VERSION = "2023-08-01";

const BASE_URLS = {
  sandbox: "https://sandbox.cashfree.com/pg",
  production: "https://api.cashfree.com/pg",
} as const;

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  env: "sandbox" | "production";
}

/** `order_meta.payment_methods` values per public payment method. */
const PAYMENT_METHODS: Record<PaymentMethod, string> = {
  upi: "upi",
  card: "cc,dc",
  netbanking: "nb",
};

interface CashfreeErrorDetails {
  error_code?: string | null;
  error_reason?: string | null;
  error_source?: string | null;
}

/** Fields of a Cashfree payment entity that this adapter reads. */
interface CashfreePayment {
  // SUCCESS | NOT_ATTEMPTED | FAILED | USER_DROPPED | VOID | CANCELLED | PENDING
  payment_status?: string | null;
  payment_group?: string | null;
  error_details?: CashfreeErrorDetails | null;
  payment_time?: string | null;
  payment_completion_time?: string | null;
}

interface CashfreeOrder {
  order_id?: string;
  payment_session_id?: string;
}

/** Statuses that end a payment without money moving. `VOID` is a voided authorisation. */
const FAILED_STATUSES = new Set(["FAILED", "USER_DROPPED", "CANCELLED", "VOID"]);

/**
 * Converts integer paise to rupees for Cashfree's `order_amount`.
 *
 * Built from integer division and remainder and parsed from its decimal string, so the
 * result is the double nearest to the exact two-decimal value (49900 → 499, 1 → 0.01,
 * 12345 → 123.45) and serialises without float drift.
 */
export function paiseToRupees(amountMinor: number): number {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new ValidationError("amountMinor must be a non-negative integer (paise)");
  }
  const rupees = Math.floor(amountMinor / 100);
  const paise = amountMinor % 100;
  return Number(`${rupees}.${String(paise).padStart(2, "0")}`);
}

function mapMethod(group: unknown): PaymentMethod | undefined {
  if (typeof group !== "string") return undefined;
  // upi, upi_credit_card, upi_ppi, upi_ppi_offline, ...
  if (group.split("_").includes("upi")) return "upi";
  if (group === "credit_card" || group === "debit_card") return "card";
  if (group === "net_banking") return "netbanking";
  return undefined;
}

function withMethod<T extends object>(out: T, group: unknown): T & { method?: PaymentMethod } {
  const m = mapMethod(group);
  return m ? { ...out, method: m } : out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function failureOf(
  status: string,
  details: CashfreeErrorDetails | null | undefined,
): Pick<Outcome, "classification" | "reason"> {
  const error_reason = str(details?.error_reason);
  const classification = classifyCashfree({
    payment_status: status,
    error_details: {
      error_code: str(details?.error_code),
      error_reason,
      error_source: str(details?.error_source),
    },
  });
  return { classification, reason: error_reason ?? status };
}

function outcomeOf(p: CashfreePayment): Outcome {
  const status = p.payment_status ?? "";
  if (status === "SUCCESS") return withMethod({ status: "paid" }, p.payment_group);
  if (FAILED_STATUSES.has(status)) {
    return withMethod({ status: "failed", ...failureOf(status, p.error_details) }, p.payment_group);
  }
  return { status: "pending" };
}

function timeOf(p: CashfreePayment): number {
  const t = Date.parse(p.payment_completion_time ?? p.payment_time ?? "");
  return Number.isNaN(t) ? 0 : t;
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    const v = Array.isArray(value) ? (value.length === 1 ? value[0] : undefined) : value;
    return v ? v : undefined;
  }
  return undefined;
}

/** Constant-time comparison; different lengths are a mismatch, never a RangeError. */
function safeEqual(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class CashfreeAdapter implements GatewayAdapter {
  readonly name = "cashfree" as const;
  readonly #appId: string;
  readonly #secretKey: string;
  readonly #env: "sandbox" | "production";
  readonly #deps: HttpDeps;

  constructor(cfg: CashfreeConfig, deps: { fetch: typeof fetch; timeoutMs: number }) {
    for (const k of ["appId", "secretKey"] as const) {
      if (typeof cfg?.[k] !== "string" || cfg[k].length === 0) {
        throw new ValidationError(`cashfree ${k} is required`);
      }
    }
    if (cfg.env !== "sandbox" && cfg.env !== "production") {
      throw new ValidationError('cashfree env must be "sandbox" or "production"');
    }
    this.#appId = cfg.appId;
    this.#secretKey = cfg.secretKey;
    this.#env = cfg.env;
    this.#deps = deps;
  }

  supports(method: PaymentMethod): boolean {
    return Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, method);
  }

  async createOrder(input: CreateOrderInput): Promise<{ gatewayRef: string; checkout: Checkout }> {
    const { customer } = input;
    const order = await this.#request<CashfreeOrder>("POST", "/orders", {
      order_id: input.attemptId,
      order_amount: paiseToRupees(input.amountMinor),
      order_currency: input.currency,
      customer_details: {
        customer_id: customer.id,
        customer_phone: customer.phone,
        ...(customer.email ? { customer_email: customer.email } : {}),
        ...(customer.name ? { customer_name: customer.name } : {}),
      },
      order_meta: { payment_methods: PAYMENT_METHODS[input.method] },
      order_tags: { orderId: input.orderId },
    });
    const paymentSessionId = str(isRecord(order) ? order.payment_session_id : undefined);
    if (!paymentSessionId) {
      throw new GatewayRequestError("cashfree", 200, "gateway", "invalid_response");
    }
    return {
      gatewayRef: input.attemptId,
      checkout: { gateway: "cashfree", paymentSessionId, mode: this.#env, method: input.method },
    };
  }

  async fetchStatus(gatewayRef: string): Promise<StatusResult> {
    const res = await this.#request<unknown>(
      "GET",
      `/orders/${encodeURIComponent(gatewayRef)}/payments`,
    );
    const items = (Array.isArray(res) ? res : []).filter(isRecord) as CashfreePayment[];
    const attempted = items.filter((p) => p.payment_status !== "NOT_ATTEMPTED");
    if (attempted.length === 0) return { status: "created" };

    const paid = attempted.find((p) => p.payment_status === "SUCCESS");
    if (paid) return outcomeOf(paid);
    // PENDING, or a status this adapter does not know: never report a failure.
    if (attempted.some((p) => !FAILED_STATUSES.has(p.payment_status ?? ""))) {
      return { status: "pending" };
    }
    // All failed: report the most recent attempt, regardless of response order.
    const latest = attempted.reduce((a, b) => (timeOf(b) >= timeOf(a) ? b : a));
    return outcomeOf(latest);
  }

  /**
   * Cashfree's return URL carries no signature, so the client payload is ignored and the
   * outcome always comes from the server-side lookup of `gatewayRef`.
   */
  async verifyCallback(gatewayRef: string, _payload: unknown): Promise<Outcome> {
    const result = await this.fetchStatus(gatewayRef);
    const { status, ...rest } = result;
    return { ...rest, status: status === "created" ? "pending" : status };
  }

  verifyWebhook(
    rawBody: string | Uint8Array,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const signature = headerValue(headers, "x-webhook-signature");
    const timestamp = headerValue(headers, "x-webhook-timestamp");
    if (!signature || !timestamp) throw new InvalidSignatureError("cashfree");
    const bytes = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
    // Cashfree signs timestamp + raw body (no separator), base64 HMAC-SHA256 with the secret key.
    const expected = createHmac("sha256", this.#secretKey)
      .update(timestamp, "utf8")
      .update(bytes)
      .digest("base64");
    if (!safeEqual(expected, signature)) throw new InvalidSignatureError("cashfree");

    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new ValidationError("cashfree webhook body is not valid JSON");
    }
    const type = isRecord(body) && typeof body.type === "string" ? body.type : "";
    const data = isRecord(body) && isRecord(body.data) ? body.data : {};
    const order = isRecord(data.order) ? data.order : {};
    const payment = (isRecord(data.payment) ? data.payment : {}) as CashfreePayment;
    const errorDetails = isRecord(data.error_details)
      ? (data.error_details as CashfreeErrorDetails)
      : payment.error_details;

    const base: WebhookEvent = {
      gateway: "cashfree",
      gatewayRef: str(order.order_id) ?? "",
      status: "other",
      raw: body,
    };
    if (type === "PAYMENT_SUCCESS_WEBHOOK") {
      return withMethod({ ...base, status: "paid" as const }, payment.payment_group);
    }
    if (type === "PAYMENT_FAILED_WEBHOOK" || type === "PAYMENT_USER_DROPPED_WEBHOOK") {
      const status =
        str(payment.payment_status) ??
        (type === "PAYMENT_USER_DROPPED_WEBHOOK" ? "USER_DROPPED" : "FAILED");
      return withMethod(
        { ...base, status: "failed" as const, ...failureOf(status, errorDetails) },
        payment.payment_group,
      );
    }
    return base;
  }

  #request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "x-client-id": this.#appId,
      "x-client-secret": this.#secretKey,
      "x-api-version": CASHFREE_API_VERSION,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetchJson<T>(
      "cashfree",
      `${BASE_URLS[this.#env]}${path}`,
      { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      this.#deps,
    );
  }
}
