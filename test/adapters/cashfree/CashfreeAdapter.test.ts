// Fixture shapes copied from the official Cashfree docs (API version 2023-08-01), with
// order ids and amounts changed to match these tests:
//   create order:        https://www.cashfree.com/docs/api-reference/payments/previous/v2023-08-01/orders/create
//   payments for order:  https://www.cashfree.com/docs/api-reference/payments/previous/v2023-08-01/payments/get-payments-for-order
//   failed payment:      https://www.cashfree.com/docs/api-reference/payments/errors (sample webhook payment)
//   webhook payloads:    https://www.cashfree.com/docs/api-reference/payments/previous/v2023-08-01/payments/webhooks
//   webhook signature:   https://www.cashfree.com/docs/payments/online/webhooks/signature-verification
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CASHFREE_API_VERSION,
  CashfreeAdapter,
  paiseToRupees,
} from "../../../src/adapters/cashfree/CashfreeAdapter.js";
import { InvalidSignatureError, ValidationError } from "../../../src/errors.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/cashfree/${name}`, import.meta.url), "utf8");
const json = <T = unknown>(name: string): T => JSON.parse(fixture(name)) as T;

const cfg = {
  appId: "TEST_APP_ID_123",
  secretKey: "cfsk_ma_test_secret_xyz",
  env: "sandbox" as const,
};
const ATT = "att_3f0b6c1e-8d2a-4b7e-9c41-5a6d7e8f9012";
const SANDBOX = "https://sandbox.cashfree.com/pg";
const PROD = "https://api.cashfree.com/pg";
const PAYMENTS = `GET ${SANDBOX}/orders/${ATT}/payments`;

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    if (!(key in routes)) return new Response(JSON.stringify({ message: "nf" }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function adapter(routes: Record<string, unknown> = {}, env: "sandbox" | "production" = "sandbox") {
  const { fetchFn, calls } = stubFetch(routes);
  return { cf: new CashfreeAdapter({ ...cfg, env }, { fetch: fetchFn, timeoutMs: 1000 }), calls };
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

const sign = (ts: string, body: string, secret = cfg.secretKey) =>
  createHmac("sha256", secret)
    .update(ts + body)
    .digest("base64");

const input = {
  attemptId: ATT,
  orderId: "ord_1001",
  amountMinor: 49900,
  currency: "INR" as const,
  method: "upi" as const,
  customer: { id: "cust1001", phone: "9000090000" },
};

type Payment = Record<string, unknown>;
const payments = (...names: string[]): Payment[] => names.flatMap((n) => json<Payment[]>(n));

describe("paiseToRupees", () => {
  it.each([
    [49900, 499],
    [1, 0.01],
    [12345, 123.45],
  ])("paiseToRupees is exact: %i → %d", (paise, rupees) => {
    expect(paiseToRupees(paise)).toBe(rupees);
  });

  it("is exact where float division drifts", () => {
    // 1.1 * 100 style drift never appears: every result serialises to two decimals at most.
    for (let p = 0; p <= 100_000; p += 7) {
      const r = paiseToRupees(p);
      const [whole, frac = ""] = String(r).split(".");
      expect(frac.length).toBeLessThanOrEqual(2);
      expect(Number(whole) * 100 + Number(frac.padEnd(2, "0"))).toBe(p);
    }
  });

  it("rejects non-integer or negative amounts", () => {
    for (const bad of [1.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(() => paiseToRupees(bad)).toThrow(ValidationError);
    }
  });
});

describe("CashfreeAdapter", () => {
  it("validates credentials without echoing them", () => {
    const deps = { fetch: stubFetch({}).fetchFn, timeoutMs: 1000 };
    expect(() => new CashfreeAdapter({ ...cfg, appId: "" }, deps)).toThrow(
      "cashfree appId is required",
    );
    expect(() => new CashfreeAdapter({ ...cfg, secretKey: "" }, deps)).toThrow(
      "cashfree secretKey is required",
    );
    expect(
      () => new CashfreeAdapter({ ...cfg, env: "live" as unknown as "sandbox" }, deps),
    ).toThrow(ValidationError);
  });

  it("supports upi, card and netbanking", () => {
    const { cf } = adapter();
    expect(cf.name).toBe("cashfree");
    expect(cf.supports("upi")).toBe(true);
    expect(cf.supports("card")).toBe(true);
    expect(cf.supports("netbanking")).toBe(true);
  });

  it("createOrder sends rupees, method filter and api version", async () => {
    const { cf, calls } = adapter({ [`POST ${SANDBOX}/orders`]: json("order.created.json") });
    const out = await cf.createOrder({
      ...input,
      customer: { ...input.customer, email: "a@example.com", name: "Asha" },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${SANDBOX}/orders`);
    expect(call.init.method).toBe("POST");
    expect(header(call.init, "x-api-version")).toBe("2023-08-01");
    expect(CASHFREE_API_VERSION).toBe("2023-08-01");
    expect(header(call.init, "x-client-id")).toBe(cfg.appId);
    expect(header(call.init, "x-client-secret")).toBe(cfg.secretKey);
    expect(header(call.init, "content-type")).toBe("application/json");
    const body = String(call.init.body);
    expect(JSON.parse(body)).toEqual({
      order_id: ATT,
      order_amount: 499,
      order_currency: "INR",
      customer_details: {
        customer_id: "cust1001",
        customer_phone: "9000090000",
        customer_email: "a@example.com",
        customer_name: "Asha",
      },
      order_meta: { payment_methods: "upi" },
      order_tags: { orderId: "ord_1001" },
    });
    expect(body).toContain('"order_amount":499,');
    expect(out).toEqual({
      gatewayRef: ATT,
      checkout: {
        gateway: "cashfree",
        paymentSessionId: json<{ payment_session_id: string }>("order.created.json")
          .payment_session_id,
        mode: "sandbox",
        method: "upi",
      },
    });
  });

  it.each([
    ["card", "cc,dc"],
    ["netbanking", "nb"],
  ] as const)(
    "createOrder maps %s → payment_methods %s; omits absent customer fields",
    async (method, pm) => {
      const { cf, calls } = adapter({ [`POST ${SANDBOX}/orders`]: json("order.created.json") });
      await cf.createOrder({ ...input, method, amountMinor: 12345 });
      const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
      expect(body.order_meta).toEqual({ payment_methods: pm });
      expect(body.order_amount).toBe(123.45);
      expect(body.customer_details).toEqual({
        customer_id: "cust1001",
        customer_phone: "9000090000",
      });
    },
  );

  it("createOrder rejects a response without a payment session", async () => {
    const { cf } = adapter({ [`POST ${SANDBOX}/orders`]: { order_id: ATT } });
    await expect(cf.createOrder(input)).rejects.toMatchObject({
      gateway: "cashfree",
      reason: "invalid_response",
    });
  });

  it("sandbox vs production base URL", async () => {
    const s = adapter({ [`POST ${SANDBOX}/orders`]: json("order.created.json") }, "sandbox");
    const sOut = await s.cf.createOrder(input);
    expect(s.calls[0]!.url).toBe(`${SANDBOX}/orders`);
    expect(sOut.checkout).toMatchObject({ mode: "sandbox" });

    const p = adapter({ [`POST ${PROD}/orders`]: json("order.created.json") }, "production");
    const pOut = await p.cf.createOrder(input);
    expect(p.calls[0]!.url).toBe(`${PROD}/orders`);
    expect(pOut.checkout).toMatchObject({ mode: "production" });

    const p2 = adapter({ [`GET ${PROD}/orders/${ATT}/payments`]: [] }, "production");
    await p2.cf.fetchStatus(ATT);
    expect(p2.calls[0]!.url).toBe(`${PROD}/orders/${ATT}/payments`);
  });

  describe("fetchStatus", () => {
    it("any SUCCESS → paid with method", async () => {
      const { cf, calls } = adapter({
        [PAYMENTS]: payments("payments.failed.bank.json", "payments.success.json"),
      });
      await expect(cf.fetchStatus(ATT)).resolves.toEqual({ status: "paid", method: "upi" });
      expect(calls[0]!.url).toBe(`${SANDBOX}/orders/${ATT}/payments`);
      expect(calls[0]!.init.method).toBe("GET");
      expect(header(calls[0]!.init, "x-api-version")).toBe("2023-08-01");
    });

    it("any PENDING (and no SUCCESS) → pending", async () => {
      const pending = { ...payments("payments.success.json")[0], payment_status: "PENDING" };
      const { cf } = adapter({ [PAYMENTS]: [...payments("payments.failed.bank.json"), pending] });
      await expect(cf.fetchStatus(ATT)).resolves.toEqual({ status: "pending" });
    });

    it("USER_DROPPED is a customer failure", async () => {
      const { cf } = adapter({ [PAYMENTS]: payments("payments.user_dropped.json") });
      await expect(cf.fetchStatus(ATT)).resolves.toEqual({
        status: "failed",
        classification: "customer",
        reason: "USER_DROPPED",
        method: "netbanking",
      });
    });

    it("FAILED with bank source is a gateway failure", async () => {
      const { cf } = adapter({ [PAYMENTS]: payments("payments.failed.bank.json") });
      await expect(cf.fetchStatus(ATT)).resolves.toEqual({
        status: "failed",
        classification: "gateway",
        reason: "bank_rejected",
        method: "upi",
      });
    });

    it("all failed → the latest attempt decides, whatever the response order", async () => {
      // user_dropped completed at 18:40, the bank failure at 18:24 on the same day.
      for (const order of [
        ["payments.failed.bank.json", "payments.user_dropped.json"],
        ["payments.user_dropped.json", "payments.failed.bank.json"],
      ]) {
        const { cf } = adapter({ [PAYMENTS]: payments(...order) });
        await expect(cf.fetchStatus(ATT)).resolves.toMatchObject({
          status: "failed",
          classification: "customer",
        });
      }
    });

    it("no payments or only NOT_ATTEMPTED → created", async () => {
      const a = adapter({ [PAYMENTS]: [] });
      await expect(a.cf.fetchStatus(ATT)).resolves.toEqual({ status: "created" });
      const notAttempted = {
        ...payments("payments.success.json")[0],
        payment_status: "NOT_ATTEMPTED",
      };
      const b = adapter({ [PAYMENTS]: [notAttempted] });
      await expect(b.cf.fetchStatus(ATT)).resolves.toEqual({ status: "created" });
    });

    it("an unrecognised status is treated as pending, never as failed", async () => {
      const odd = { ...payments("payments.success.json")[0], payment_status: "SOMETHING_NEW" };
      const { cf } = adapter({ [PAYMENTS]: [...payments("payments.failed.bank.json"), odd] });
      await expect(cf.fetchStatus(ATT)).resolves.toEqual({ status: "pending" });
    });

    it("encodes the order id in the path", async () => {
      const { cf, calls } = adapter();
      await cf.fetchStatus("a/b?c").catch(() => undefined);
      expect(calls[0]!.url).toBe(`${SANDBOX}/orders/a%2Fb%3Fc/payments`);
    });
  });

  describe("verifyCallback", () => {
    it("verifyCallback trusts only the server lookup", async () => {
      const { cf, calls } = adapter({ [PAYMENTS]: payments("payments.failed.bank.json") });
      const clientSays = { order_id: ATT, order_status: "PAID", payment_status: "SUCCESS" };
      await expect(cf.verifyCallback(ATT, clientSays)).resolves.toEqual({
        status: "failed",
        classification: "gateway",
        reason: "bank_rejected",
        method: "upi",
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe(`${SANDBOX}/orders/${ATT}/payments`);
    });

    it("looks up gatewayRef, not the order id in the client payload", async () => {
      const { cf, calls } = adapter({ [PAYMENTS]: payments("payments.success.json") });
      await expect(cf.verifyCallback(ATT, { order_id: "att_someone_else" })).resolves.toEqual({
        status: "paid",
        method: "upi",
      });
      expect(calls[0]!.url).toBe(`${SANDBOX}/orders/${ATT}/payments`);
    });

    it("no attempt yet → pending (an Outcome cannot be created)", async () => {
      const { cf } = adapter({ [PAYMENTS]: [] });
      await expect(cf.verifyCallback(ATT, undefined)).resolves.toEqual({ status: "pending" });
    });
  });

  describe("verifyWebhook", () => {
    const raw = fixture("webhook.payment.failed.json");
    const ts = "1746427759733";
    const sig = sign(ts, raw);

    it("verifyWebhook accepts valid", () => {
      const { cf, calls } = adapter();
      const ev = cf.verifyWebhook(raw, { "x-webhook-signature": sig, "x-webhook-timestamp": ts });
      expect(ev).toEqual({
        gateway: "cashfree",
        gatewayRef: ATT,
        status: "failed",
        method: "upi",
        classification: "gateway",
        reason: "debit_failed",
        raw: JSON.parse(raw),
      });
      expect(calls).toHaveLength(0);
    });

    it("accepts Uint8Array bodies and any header casing", () => {
      const { cf } = adapter();
      const ev = cf.verifyWebhook(new TextEncoder().encode(raw), {
        "X-Webhook-Signature": sig,
        "X-Webhook-Timestamp": ts,
      });
      expect(ev.status).toBe("failed");
    });

    it("maps success → paid, user dropped → failed customer, others → other", () => {
      const { cf } = adapter();
      const base = JSON.parse(raw) as { data: { payment: Payment } };
      const make = (type: string, payment: Payment, extra: object = {}) => {
        const body = JSON.stringify({
          data: { order: { order_id: ATT }, payment, ...extra },
          event_time: "2025-04-03T14:57:38+05:30",
          type,
        });
        return cf.verifyWebhook(body, {
          "x-webhook-signature": sign(ts, body),
          "x-webhook-timestamp": ts,
        });
      };
      expect(
        make("PAYMENT_SUCCESS_WEBHOOK", { ...base.data.payment, payment_status: "SUCCESS" }),
      ).toMatchObject({ status: "paid", gatewayRef: ATT, method: "upi" });
      expect(
        make("PAYMENT_USER_DROPPED_WEBHOOK", {
          ...base.data.payment,
          payment_status: "USER_DROPPED",
          payment_group: "net_banking",
        }),
      ).toMatchObject({
        status: "failed",
        classification: "customer",
        reason: "USER_DROPPED",
        method: "netbanking",
      });
      expect(
        make("PAYMENT_CHARGES_WEBHOOK", { ...base.data.payment, payment_status: "SUCCESS" }),
      ).toMatchObject({ status: "other", gatewayRef: ATT });
    });

    it("verifyWebhook rejects tampered", () => {
      const { cf } = adapter();
      const last = sig.at(-2) === "A" ? "B" : "A";
      const tampered = sig.slice(0, -2) + last + sig.slice(-1);
      const h = (s: string) => ({ "x-webhook-signature": s, "x-webhook-timestamp": ts });
      expect(() => cf.verifyWebhook(raw, h(tampered))).toThrow(InvalidSignatureError);
      // Different length: rejected, not a RangeError from timingSafeEqual.
      expect(() => cf.verifyWebhook(raw, h("short"))).toThrow(InvalidSignatureError);
      // Signed with another timestamp.
      expect(() =>
        cf.verifyWebhook(raw, {
          "x-webhook-signature": sig,
          "x-webhook-timestamp": "1746427759734",
        }),
      ).toThrow(InvalidSignatureError);
      // Signed with the wrong key.
      expect(() => cf.verifyWebhook(raw, h(sign(ts, raw, "other_secret")))).toThrow(
        InvalidSignatureError,
      );
      // Body altered.
      expect(() => cf.verifyWebhook(raw.replace("debit_failed", "user_dropped"), h(sig))).toThrow(
        InvalidSignatureError,
      );
    });

    it("verifyWebhook rejects missing timestamp", () => {
      const { cf } = adapter();
      expect(() => cf.verifyWebhook(raw, { "x-webhook-signature": sig })).toThrow(
        InvalidSignatureError,
      );
      expect(() =>
        cf.verifyWebhook(raw, { "x-webhook-signature": sig, "x-webhook-timestamp": "" }),
      ).toThrow(InvalidSignatureError);
      // The signature over the body alone (no timestamp prefix) is not accepted either.
      expect(() =>
        cf.verifyWebhook(raw, {
          "x-webhook-signature": sign("", raw),
          "x-webhook-timestamp": undefined,
        }),
      ).toThrow(InvalidSignatureError);
    });

    it("rejects a missing signature", () => {
      const { cf } = adapter();
      expect(() => cf.verifyWebhook(raw, { "x-webhook-timestamp": ts })).toThrow(
        InvalidSignatureError,
      );
      expect(() =>
        cf.verifyWebhook(raw, { "x-webhook-signature": "", "x-webhook-timestamp": ts }),
      ).toThrow(InvalidSignatureError);
    });

    it("rejects a body that was JSON.parse'd and re-stringified", () => {
      const { cf } = adapter();
      const reserialized = JSON.stringify(JSON.parse(raw));
      expect(reserialized).not.toBe(raw);
      expect(() =>
        cf.verifyWebhook(reserialized, { "x-webhook-signature": sig, "x-webhook-timestamp": ts }),
      ).toThrow(InvalidSignatureError);
    });
  });

  it("never leaks credentials in request errors", async () => {
    const fail = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const cf = new CashfreeAdapter(cfg, { fetch: fail, timeoutMs: 1000 });
    for (const p of [cf.fetchStatus(ATT), cf.createOrder(input), cf.verifyCallback(ATT, {})]) {
      const err = (await p.catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(Error);
      const dump = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`;
      expect(dump).not.toContain(cfg.secretKey);
    }
    const badCfg = () => new CashfreeAdapter({ ...cfg, appId: "" }, { fetch: fail, timeoutMs: 1 });
    const err = (() => {
      try {
        badCfg();
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(`${err?.message} ${err?.stack ?? ""}`).not.toContain(cfg.secretKey);
    expect(JSON.stringify(cf)).not.toContain(cfg.secretKey);
  });
});

describe("public exports", () => {
  it("exports the Cashfree adapter, classifier and helpers from the package entry", async () => {
    const pkg = await import("../../../src/index.js");
    expect(pkg.CashfreeAdapter).toBe(CashfreeAdapter);
    expect(pkg.paiseToRupees).toBe(paiseToRupees);
    expect(typeof pkg.classifyCashfree).toBe("function");
    expect(pkg.CASHFREE_REASON_CLASSIFICATION.length).toBeGreaterThan(0);
    expect(pkg.CASHFREE_SOURCE_CLASSIFICATION.length).toBeGreaterThan(0);
    expect(pkg.CASHFREE_CUSTOMER_STATUSES).toEqual(["USER_DROPPED", "CANCELLED"]);
  });
});

describe("createOrder input checks (R12)", () => {
  const route = { [`POST ${SANDBOX}/orders`]: json("order.created.json") };

  it("amountMinor 99 → ValidationError with no fetch", async () => {
    const { cf, calls } = adapter(route);
    await expect(cf.createOrder({ ...input, amountMinor: 99 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(cf.createOrder({ ...input, amountMinor: 0 })).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(calls).toHaveLength(0);
    await cf.createOrder({ ...input, amountMinor: 100 });
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ order_amount: 1 });
  });

  it.each(["", "900009000", "90000900001", "90000-90000", "+91", "+91 9000090000", "phone12345"])(
    "invalid phone %j → ValidationError with no fetch",
    async (phone) => {
      const { cf, calls } = adapter(route);
      const err = await cf
        .createOrder({ ...input, customer: { ...input.customer, phone } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      if (phone) expect((err as Error).message).not.toContain(phone);
      expect(calls).toHaveLength(0);
    },
  );

  it.each(["9000090000", "+919000090000", "+14155550123"])(
    "valid phone %s is sent unchanged",
    async (phone) => {
      const { cf, calls } = adapter(route);
      await cf.createOrder({ ...input, customer: { ...input.customer, phone } });
      const body = JSON.parse(String(calls[0]!.init.body)) as {
        customer_details: { customer_phone: string };
      };
      expect(body.customer_details.customer_phone).toBe(phone);
    },
  );

  it.each([
    ["c1", "0c1"],
    ["user 42!", "user42"],
    ["cust_1001-a", "cust1001a"],
    ["!!", "000"],
    ["x".repeat(60), "x".repeat(50)],
    ["cust1001", "cust1001"],
  ])("customer id %j is normalised to %j", async (id, expected) => {
    const { cf, calls } = adapter(route);
    await cf.createOrder({ ...input, customer: { ...input.customer, id } });
    const body = JSON.parse(String(calls[0]!.init.body)) as {
      customer_details: { customer_id: string };
    };
    expect(body.customer_details.customer_id).toBe(expected);
  });
});

describe("cancelOrder (R13)", () => {
  const url = `PATCH ${SANDBOX}/orders/${ATT}`;
  const order = (order_status: string) => ({
    ...json<Record<string, unknown>>("order.created.json"),
    order_status,
  });

  it("terminates the order with PATCH order_status TERMINATED", async () => {
    const { cf, calls } = adapter({ [url]: order("TERMINATED") });
    await expect(cf.cancelOrder(ATT)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${SANDBOX}/orders/${ATT}`);
    expect(call.init.method).toBe("PATCH");
    expect(JSON.parse(String(call.init.body))).toEqual({ order_status: "TERMINATED" });
    expect(header(call.init, "x-api-version")).toBe("2023-08-01");
    expect(header(call.init, "x-client-id")).toBe(cfg.appId);
    expect(header(call.init, "x-client-secret")).toBe(cfg.secretKey);
    expect(header(call.init, "content-type")).toBe("application/json");
  });

  it("accepts TERMINATION_REQUESTED and EXPIRED", async () => {
    for (const s of ["TERMINATION_REQUESTED", "EXPIRED"]) {
      const { cf } = adapter({ [url]: order(s) });
      await expect(cf.cancelOrder(ATT)).resolves.toBeUndefined();
    }
  });

  it("rejects when the order was paid or stays active", async () => {
    const paid = adapter({ [url]: order("PAID") });
    await expect(paid.cf.cancelOrder(ATT)).rejects.toMatchObject({
      gateway: "cashfree",
      reason: "order_paid",
      classification: "unknown",
    });
    const active = adapter({ [url]: order("ACTIVE") });
    await expect(active.cf.cancelOrder(ATT)).rejects.toMatchObject({
      gateway: "cashfree",
      reason: "not_terminated",
    });
  });

  it("URL-encodes the order id and uses the production URL in production", async () => {
    const s = adapter();
    await s.cf.cancelOrder("a/b?c").catch(() => undefined);
    expect(s.calls[0]!.url).toBe(`${SANDBOX}/orders/a%2Fb%3Fc`);
    const p = adapter({ [`PATCH ${PROD}/orders/${ATT}`]: order("TERMINATED") }, "production");
    await p.cf.cancelOrder(ATT);
    expect(p.calls[0]!.url).toBe(`${PROD}/orders/${ATT}`);
  });

  it("never leaks credentials when termination fails", async () => {
    const fail = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const cf = new CashfreeAdapter(cfg, { fetch: fail, timeoutMs: 1000 });
    const err = (await cf.cancelOrder(ATT).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(`${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`).not.toContain(cfg.secretKey);
  });

  it("verifyWebhook rejects a parsed body with a ValidationError", () => {
    const { cf } = adapter();
    expect(() =>
      cf.verifyWebhook({ type: "PAYMENT_SUCCESS_WEBHOOK" } as unknown as string, {
        "x-webhook-signature": "abc",
        "x-webhook-timestamp": "1",
      }),
    ).toThrow(new ValidationError("pass the raw request body"));
  });
});
