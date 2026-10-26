import { createHmac, timingSafeEqual } from "node:crypto";
import { InvalidSignatureError, ValidationError } from "../../errors.js";
import { fetchJson, type HttpDeps } from "../../http.js";
import type { Checkout, Outcome, PaymentMethod } from "../../types.js";
import type { CreateOrderInput, GatewayAdapter, StatusResult, WebhookEvent } from "../Adapter.js";
import { classifyRazorpay } from "./classify.js";

// API reference: https://razorpay.com/docs/api/
const BASE_URL = "https://api.razorpay.com/v1";

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

/** Fields of a Razorpay payment entity that this adapter reads. */
interface RazorpayPayment {
  id: string;
  status: string; // created | authorized | captured | refunded | failed
  order_id?: string | null;
  method?: string | null;
  error_code?: string | null;
  error_source?: string | null;
  error_reason?: string | null;
  created_at?: number;
}

interface RazorpayOrder {
  id: string;
}

const PAID_STATUSES = new Set(["captured", "authorized", "refunded"]);
const METHODS: Record<string, PaymentMethod> = {
  upi: "upi",
  card: "card",
  netbanking: "netbanking",
};

function mapMethod(method: unknown): PaymentMethod | undefined {
  return typeof method === "string" ? METHODS[method] : undefined;
}

function hmacHex(secret: string, data: string | Uint8Array): string {
  return createHmac("sha256", secret).update(data).digest("hex");
}

/** Constant-time comparison; different lengths are a mismatch, never a RangeError. */
function safeEqual(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function failureOf(p: RazorpayPayment): Pick<Outcome, "classification" | "reason"> {
  return {
    classification: classifyRazorpay({
      source: p.error_source ?? undefined,
      reason: p.error_reason ?? undefined,
      code: p.error_code ?? undefined,
    }),
    ...(p.error_reason ? { reason: p.error_reason } : {}),
  };
}

function withMethod<T extends object>(out: T, method: unknown): T & { method?: PaymentMethod } {
  const m = mapMethod(method);
  return m ? { ...out, method: m } : out;
}

function outcomeOf(p: RazorpayPayment): Outcome {
  if (PAID_STATUSES.has(p.status)) return withMethod({ status: "paid" }, p.method);
  if (p.status === "failed") return withMethod({ status: "failed", ...failureOf(p) }, p.method);
  return { status: "pending" };
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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export class RazorpayAdapter implements GatewayAdapter {
  readonly name = "razorpay" as const;
  readonly #cfg: RazorpayConfig;
  readonly #deps: HttpDeps;
  readonly #auth: string;

  constructor(cfg: RazorpayConfig, deps: { fetch: typeof fetch; timeoutMs: number }) {
    for (const k of ["keyId", "keySecret", "webhookSecret"] as const) {
      if (typeof cfg?.[k] !== "string" || cfg[k].length === 0) {
        throw new ValidationError(`razorpay ${k} is required`);
      }
    }
    this.#cfg = { ...cfg };
    this.#deps = deps;
    this.#auth = `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64")}`;
  }

  supports(_method: PaymentMethod): boolean {
    return true;
  }

  async createOrder(input: CreateOrderInput): Promise<{ gatewayRef: string; checkout: Checkout }> {
    const order = await this.#request<RazorpayOrder>("POST", "/orders", {
      amount: input.amountMinor,
      currency: input.currency,
      receipt: input.orderId,
      notes: { attemptId: input.attemptId },
    });
    return {
      gatewayRef: order.id,
      checkout: {
        gateway: "razorpay",
        keyId: this.#cfg.keyId,
        orderId: order.id,
        amountMinor: input.amountMinor,
        currency: input.currency,
        method: input.method,
      },
    };
  }

  async fetchStatus(gatewayRef: string): Promise<StatusResult> {
    const res = await this.#request<{ items?: RazorpayPayment[] }>(
      "GET",
      `/orders/${encodeURIComponent(gatewayRef)}/payments`,
    );
    const items = Array.isArray(res.items) ? res.items : [];
    if (items.length === 0) return { status: "created" };

    const paid = items.find((p) => PAID_STATUSES.has(p.status));
    if (paid) return outcomeOf(paid);
    if (items.some((p) => p.status !== "failed")) return { status: "pending" };

    // All failed: report the most recent attempt, regardless of response order.
    const latest = items.reduce((a, b) => ((b.created_at ?? 0) >= (a.created_at ?? 0) ? b : a));
    return outcomeOf(latest);
  }

  async verifyCallback(gatewayRef: string, payload: unknown): Promise<Outcome> {
    if (!isRecord(payload)) throw new InvalidSignatureError("razorpay");
    const orderId = payload.razorpay_order_id;
    const paymentId = payload.razorpay_payment_id;
    const signature = payload.razorpay_signature;
    if (
      typeof orderId !== "string" ||
      typeof paymentId !== "string" ||
      typeof signature !== "string" ||
      paymentId.length === 0 ||
      orderId !== gatewayRef
    ) {
      throw new InvalidSignatureError("razorpay");
    }
    // Razorpay: sign with the order id stored on the server, not the one Checkout returned.
    const expected = hmacHex(this.#cfg.keySecret, `${gatewayRef}|${paymentId}`);
    if (!safeEqual(expected, signature)) throw new InvalidSignatureError("razorpay");

    const payment = await this.#request<RazorpayPayment>(
      "GET",
      `/payments/${encodeURIComponent(paymentId)}`,
    );
    return outcomeOf(payment);
  }

  verifyWebhook(
    rawBody: string | Uint8Array,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const signature = headerValue(headers, "x-razorpay-signature");
    if (!signature) throw new InvalidSignatureError("razorpay");
    const bytes = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
    if (!safeEqual(hmacHex(this.#cfg.webhookSecret, bytes), signature)) {
      throw new InvalidSignatureError("razorpay");
    }

    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new ValidationError("razorpay webhook body is not valid JSON");
    }
    const event = isRecord(body) && typeof body.event === "string" ? body.event : "";
    const payloadObj = isRecord(body) && isRecord(body.payload) ? body.payload : {};
    const payment =
      isRecord(payloadObj.payment) && isRecord(payloadObj.payment.entity)
        ? (payloadObj.payment.entity as unknown as RazorpayPayment)
        : undefined;
    const order =
      isRecord(payloadObj.order) && isRecord(payloadObj.order.entity)
        ? payloadObj.order.entity
        : undefined;
    const gatewayRef =
      (typeof payment?.order_id === "string" && payment.order_id) ||
      (typeof order?.id === "string" && order.id) ||
      "";

    const eventId = headerValue(headers, "x-razorpay-event-id");
    const base: WebhookEvent = {
      gateway: "razorpay",
      gatewayRef,
      status: "other",
      raw: body,
      ...(eventId ? { eventId } : {}),
    };
    if (event === "payment.captured") {
      return withMethod({ ...base, status: "paid" as const }, payment?.method);
    }
    if (event === "payment.failed" && payment) {
      return withMethod(
        { ...base, status: "failed" as const, ...failureOf(payment) },
        payment.method,
      );
    }
    return base;
  }

  #request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: this.#auth,
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    return fetchJson<T>(
      "razorpay",
      `${BASE_URL}${path}`,
      { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
      this.#deps,
    );
  }
}
