// Fixture shapes copied from the official Razorpay docs:
//   order:            https://razorpay.com/docs/api/orders/create/
//   payment entity:   https://razorpay.com/docs/api/payments/fetch-with-id/
//   order payments:   https://razorpay.com/docs/api/orders/fetch-payments/
//   webhook payload:  https://razorpay.com/docs/webhooks/payments/
//   signatures:       https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/
//                     https://razorpay.com/docs/webhooks/validate-test/
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RazorpayAdapter } from "../../../src/adapters/razorpay/RazorpayAdapter.js";
import { InvalidSignatureError, ValidationError } from "../../../src/errors.js";

const fixture = (name: string): string =>
  readFileSync(new URL(`../../fixtures/razorpay/${name}`, import.meta.url), "utf8");
const json = (name: string): unknown => JSON.parse(fixture(name));

const cfg = { keyId: "rzp_test_KEY", keySecret: "key_secret_xyz", webhookSecret: "whsec_abc" };
const ORDER_ID = "order_RB58MiP5SPFYyM";
const PAY_ID = "pay_N8FVRD1DzYzBh1";

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = `${init.method ?? "GET"} ${url}`;
    if (!(key in routes)) return new Response(JSON.stringify({ error: {} }), { status: 404 });
    return new Response(JSON.stringify(routes[key]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function adapter(routes: Record<string, unknown> = {}) {
  const { fetchFn, calls } = stubFetch(routes);
  return { rp: new RazorpayAdapter(cfg, { fetch: fetchFn, timeoutMs: 1000 }), calls };
}

const sign = (data: string, secret: string) =>
  createHmac("sha256", secret).update(data).digest("hex");

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe("RazorpayAdapter", () => {
  it("supports upi, card and netbanking", () => {
    const { rp } = adapter();
    expect(rp.name).toBe("razorpay");
    expect(rp.supports("upi")).toBe(true);
    expect(rp.supports("card")).toBe(true);
    expect(rp.supports("netbanking")).toBe(true);
  });

  it("createOrder posts paise and returns checkout", async () => {
    const { rp, calls } = adapter({
      "POST https://api.razorpay.com/v1/orders": json("order.created.json"),
    });
    const out = await rp.createOrder({
      attemptId: "att_1",
      orderId: "ord_1001",
      amountMinor: 49900,
      currency: "INR",
      method: "upi",
      customer: { id: "c1", phone: "+919000090000" },
    });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://api.razorpay.com/v1/orders");
    expect(call.init.method).toBe("POST");
    expect(header(call.init, "authorization")).toBe(
      `Basic ${Buffer.from("rzp_test_KEY:key_secret_xyz").toString("base64")}`,
    );
    expect(header(call.init, "content-type")).toBe("application/json");
    expect(JSON.parse(String(call.init.body))).toEqual({
      amount: 49900,
      currency: "INR",
      receipt: "ord_1001",
      notes: { attemptId: "att_1" },
    });
    expect(out).toEqual({
      gatewayRef: ORDER_ID,
      checkout: {
        gateway: "razorpay",
        keyId: "rzp_test_KEY",
        orderId: ORDER_ID,
        amountMinor: 49900,
        currency: "INR",
        method: "upi",
      },
    });
  });

  describe("verifyCallback", () => {
    const valid = {
      razorpay_order_id: ORDER_ID,
      razorpay_payment_id: PAY_ID,
      razorpay_signature: sign(`${ORDER_ID}|${PAY_ID}`, cfg.keySecret),
    };

    it("verifyCallback accepts a valid signature", async () => {
      const { rp, calls } = adapter({
        [`GET https://api.razorpay.com/v1/payments/${PAY_ID}`]: json("payment.captured.json"),
      });
      await expect(rp.verifyCallback(ORDER_ID, valid)).resolves.toEqual({
        status: "paid",
        method: "upi",
      });
      expect(calls[0]!.url).toBe(`https://api.razorpay.com/v1/payments/${PAY_ID}`);
    });

    it("verifyCallback rejects a tampered signature", async () => {
      const { rp, calls } = adapter();
      const last = valid.razorpay_signature.at(-1) === "0" ? "1" : "0";
      const tampered = {
        ...valid,
        razorpay_signature: valid.razorpay_signature.slice(0, -1) + last,
      };
      await expect(rp.verifyCallback(ORDER_ID, tampered)).rejects.toBeInstanceOf(
        InvalidSignatureError,
      );
      // Different length: rejected, not a RangeError from timingSafeEqual.
      await expect(
        rp.verifyCallback(ORDER_ID, { ...valid, razorpay_signature: "short" }),
      ).rejects.toBeInstanceOf(InvalidSignatureError);
      await expect(
        rp.verifyCallback(ORDER_ID, { ...valid, razorpay_signature: undefined }),
      ).rejects.toBeInstanceOf(InvalidSignatureError);
      await expect(rp.verifyCallback(ORDER_ID, null)).rejects.toBeInstanceOf(InvalidSignatureError);
      expect(calls).toHaveLength(0);
    });

    it("verifyCallback rejects an order id that doesn't match gatewayRef", async () => {
      const { rp, calls } = adapter();
      // A genuine, correctly signed callback for a *different* order must not settle this one.
      const otherOrder = "order_OTHER0000001";
      const replay = {
        razorpay_order_id: otherOrder,
        razorpay_payment_id: PAY_ID,
        razorpay_signature: sign(`${otherOrder}|${PAY_ID}`, cfg.keySecret),
      };
      await expect(rp.verifyCallback(ORDER_ID, replay)).rejects.toBeInstanceOf(
        InvalidSignatureError,
      );
      expect(calls).toHaveLength(0);
    });

    it("maps a failed payment to failed + classification", async () => {
      const { rp } = adapter({
        [`GET https://api.razorpay.com/v1/payments/${PAY_ID}`]: json(
          "payment.failed.cancelled.json",
        ),
      });
      await expect(rp.verifyCallback(ORDER_ID, valid)).resolves.toEqual({
        status: "failed",
        classification: "customer",
        reason: "payment_cancelled",
        method: "card",
      });
    });
  });

  describe("verifyWebhook", () => {
    const raw = fixture("webhook.payment.failed.json");
    const sig = sign(raw, cfg.webhookSecret);

    it("payment.failed with source customer → classification customer", () => {
      const { rp } = adapter();
      const ev = rp.verifyWebhook(raw, {
        "x-razorpay-signature": sig,
        "x-razorpay-event-id": "evt_123",
      });
      expect(ev).toMatchObject({
        gateway: "razorpay",
        gatewayRef: ORDER_ID,
        eventId: "evt_123",
        status: "failed",
        method: "upi",
        classification: "customer",
        reason: "payment_failed",
      });
      expect(ev.raw).toEqual(JSON.parse(raw));
    });

    it("accepts Uint8Array bodies and any header casing", () => {
      const { rp } = adapter();
      const ev = rp.verifyWebhook(new TextEncoder().encode(raw), { "X-Razorpay-Signature": sig });
      expect(ev.status).toBe("failed");
      expect(ev.eventId).toBeUndefined();
    });

    it("maps payment.captured → paid and other events → other", () => {
      const { rp } = adapter();
      const captured = JSON.stringify({
        entity: "event",
        event: "payment.captured",
        contains: ["payment"],
        payload: { payment: { entity: json("payment.captured.json") } },
      });
      expect(
        rp.verifyWebhook(captured, {
          "x-razorpay-signature": sign(captured, cfg.webhookSecret),
        }),
      ).toMatchObject({ status: "paid", gatewayRef: ORDER_ID, method: "upi" });

      const refund = JSON.stringify({
        entity: "event",
        event: "refund.created",
        contains: ["refund", "payment"],
        payload: { payment: { entity: json("payment.captured.json") } },
      });
      expect(
        rp.verifyWebhook(refund, { "x-razorpay-signature": sign(refund, cfg.webhookSecret) }),
      ).toMatchObject({ status: "other", gatewayRef: ORDER_ID });
    });

    it("verifyWebhook rejects missing header", () => {
      const { rp } = adapter();
      expect(() => rp.verifyWebhook(raw, {})).toThrow(InvalidSignatureError);
      expect(() => rp.verifyWebhook(raw, { "x-razorpay-signature": undefined })).toThrow(
        InvalidSignatureError,
      );
      expect(() => rp.verifyWebhook(raw, { "x-razorpay-signature": "" })).toThrow(
        InvalidSignatureError,
      );
    });

    it("rejects a signature made with the wrong secret", () => {
      const { rp } = adapter();
      expect(() =>
        rp.verifyWebhook(raw, { "x-razorpay-signature": sign(raw, cfg.keySecret) }),
      ).toThrow(InvalidSignatureError);
    });

    it("verifyWebhook rejects a body that was JSON.parse'd and re-stringified", () => {
      const { rp } = adapter();
      const reserialized = JSON.stringify(JSON.parse(raw));
      expect(reserialized).not.toBe(raw);
      expect(() => rp.verifyWebhook(reserialized, { "x-razorpay-signature": sig })).toThrow(
        InvalidSignatureError,
      );
    });
  });

  describe("fetchStatus", () => {
    const url = `GET https://api.razorpay.com/v1/orders/${ORDER_ID}/payments`;
    const collection = (...items: unknown[]) => ({
      entity: "collection",
      count: items.length,
      items,
    });

    it("fetchStatus: one failed + one captured → paid", async () => {
      const { rp, calls } = adapter({
        [url]: collection(json("payment.failed.bank.json"), json("payment.captured.json")),
      });
      await expect(rp.fetchStatus(ORDER_ID)).resolves.toEqual({ status: "paid", method: "upi" });
      expect(calls[0]!.url).toBe(`https://api.razorpay.com/v1/orders/${ORDER_ID}/payments`);
    });

    it("all failed → failed with the latest payment's classification", async () => {
      const { rp } = adapter({
        [url]: collection(json("payment.failed.cancelled.json"), json("payment.failed.bank.json")),
      });
      // cancelled.created_at (...150) is later than bank.created_at (...100), whatever the order.
      await expect(rp.fetchStatus(ORDER_ID)).resolves.toEqual({
        status: "failed",
        classification: "customer",
        reason: "payment_cancelled",
        method: "card",
      });
    });

    it("a created payment → pending; no payments → created", async () => {
      const created = { ...(json("payment.captured.json") as object), status: "created" };
      const a = adapter({ [url]: collection(json("payment.failed.bank.json"), created) });
      await expect(a.rp.fetchStatus(ORDER_ID)).resolves.toEqual({ status: "pending" });
      const b = adapter({ [url]: collection() });
      await expect(b.rp.fetchStatus(ORDER_ID)).resolves.toEqual({ status: "created" });
    });
  });

  it("never leaks credentials in request errors", async () => {
    const fail = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const rp = new RazorpayAdapter(cfg, { fetch: fail, timeoutMs: 1000 });
    const err = (await rp.fetchStatus(ORDER_ID).catch((e: unknown) => e)) as Error;
    const dump = `${err.message} ${err.stack ?? ""} ${JSON.stringify(err)}`;
    const basic = Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString("base64");
    for (const s of [cfg.keySecret, cfg.webhookSecret, basic]) {
      expect(dump).not.toContain(s);
    }
  });

  it("createOrder rejects less than 100 paise before any request", async () => {
    const { rp, calls } = adapter();
    await expect(
      rp.createOrder({
        attemptId: "att_1",
        orderId: "ord_1001",
        amountMinor: 99,
        currency: "INR",
        method: "upi",
        customer: { id: "c1", phone: "9999999999" },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(0);
  });

  it("verifyWebhook rejects a parsed body with a ValidationError", () => {
    const { rp } = adapter();
    expect(() =>
      rp.verifyWebhook({ event: "payment.captured" } as unknown as string, {
        "x-razorpay-signature": "abc",
      }),
    ).toThrow(new ValidationError("pass the raw request body"));
  });
});
