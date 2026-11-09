import { describe, expect, it, vi } from "vitest";
import { GatewayGuard, type GuardEvent } from "../src/GatewayGuard.js";
import type {
  CreateOrderInput,
  GatewayAdapter,
  StatusResult,
  WebhookEvent,
} from "../src/adapters/Adapter.js";
import {
  GatewayRequestError,
  InvalidSignatureError,
  RetryNotAllowedError,
  ValidationError,
} from "../src/errors.js";
import type { Checkout, GatewayName, Outcome, PaymentMethod } from "../src/types.js";

class FakeAdapter implements GatewayAdapter {
  private n = 0;
  readonly created: CreateOrderInput[] = [];
  createOrder = vi.fn(async (input: CreateOrderInput) => {
    this.created.push(input);
    const gatewayRef = `${this.name}_ref_${++this.n}`;
    const checkout: Checkout =
      this.name === "cashfree"
        ? { gateway: "cashfree", paymentSessionId: "sess", mode: "sandbox", method: input.method }
        : {
            gateway: "razorpay",
            keyId: "rzp_test",
            orderId: gatewayRef,
            amountMinor: input.amountMinor,
            currency: "INR",
            method: input.method,
          };
    return { gatewayRef, checkout };
  });
  fetchStatus = vi.fn(async (_ref: string): Promise<StatusResult> => ({ status: "failed" }));
  verifyCallback = vi.fn(async (_ref: string, _payload: unknown): Promise<Outcome> => ({
    status: "paid",
  }));
  cancelOrder?: (ref: string) => Promise<void>;

  constructor(
    readonly name: GatewayName,
    private readonly methods: PaymentMethod[] = ["upi", "card", "netbanking"],
  ) {}

  supports(method: PaymentMethod): boolean {
    return this.methods.includes(method);
  }

  verifyWebhook(
    rawBody: string | Uint8Array,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    if (headers["x-sig"] !== "good") throw new InvalidSignatureError(this.name);
    const body = JSON.parse(String(rawBody)) as {
      ref: string;
      status: WebhookEvent["status"];
      classification?: WebhookEvent["classification"];
    };
    const event: WebhookEvent = {
      gateway: this.name,
      gatewayRef: body.ref,
      status: body.status,
      raw: body,
    };
    if (body.classification) event.classification = body.classification;
    return event;
  }
}

const customer = { id: "c1", phone: "9999999999" };

function input(method: PaymentMethod = "upi", extra: { orderId?: string; retryOf?: string } = {}) {
  return {
    orderId: extra.orderId ?? "order_1",
    amountMinor: 50_000,
    currency: "INR" as const,
    method,
    customer,
    ...(extra.retryOf ? { retryOf: extra.retryOf } : {}),
  };
}

function setup(opts: { onListenerError?: (e: unknown, ev: GuardEvent) => void } = {}) {
  const clock = { t: 1_000_000 };
  const rp = new FakeAdapter("razorpay");
  const cf = new FakeAdapter("cashfree");
  const guard = new GatewayGuard({
    gateways: {},
    priority: ["razorpay", "cashfree"],
    adapters: [rp, cf],
    now: () => clock.t,
    random: () => 0.9,
    ...opts,
  });
  const events: GuardEvent[] = [];
  for (const type of [
    "attempt.created",
    "attempt.succeeded",
    "attempt.failed",
    "health.changed",
    "route.failover",
    "webhook.unmatched",
    "order.multiple-payments",
    "route.all-down",
  ] as const) {
    guard.on(type, (e) => events.push(e));
  }
  return { guard, rp, cf, clock, events };
}

function webhook(ref: string, status: string, classification?: string) {
  return JSON.stringify({ ref, status, classification });
}

const good = { "x-sig": "good" };

function countedFor(guard: GatewayGuard, gateway: GatewayName, method: PaymentMethod): number {
  return (
    guard.health().find((h) => h.gateway === gateway && h.method === method)?.countedAttempts ?? 0
  );
}

describe("GatewayGuard", () => {
  it("routes netbanking away from an unhealthy pair, keeps upi", async () => {
    const { guard, rp, events } = setup();
    rp.verifyCallback.mockResolvedValue({ status: "failed", classification: "gateway" });
    for (let i = 0; i < 5; i++) {
      const { attemptId, gateway } = await guard.createPayment(
        input("netbanking", { orderId: `nb_${i}` }),
      );
      expect(gateway).toBe("razorpay");
      await guard.verifyPayment(attemptId, {});
    }
    expect(events.some((e) => e.type === "health.changed")).toBe(true);

    const nb = await guard.createPayment(input("netbanking", { orderId: "nb_next" }));
    expect(nb.gateway).toBe("cashfree");
    expect(events).toContainEqual({
      type: "route.failover",
      method: "netbanking",
      from: "razorpay",
      to: "cashfree",
      why: "unhealthy",
    });
    const created = events.filter((e) => e.type === "attempt.created").at(-1);
    expect(created).toMatchObject({ reason: "failover" });

    const upi = await guard.createPayment(input("upi"));
    expect(upi.gateway).toBe("razorpay");
  });

  it("customer cancellations don't trigger failover", async () => {
    const { guard, rp, events } = setup();
    rp.verifyCallback.mockResolvedValue({ status: "failed", classification: "customer" });
    for (let i = 0; i < 10; i++) {
      const { attemptId } = await guard.createPayment(input("upi", { orderId: `o_${i}` }));
      await guard.verifyPayment(attemptId, {});
    }
    const next = await guard.createPayment(input());
    expect(next.gateway).toBe("razorpay");
    const failed = events.filter((e) => e.type === "attempt.failed");
    expect(failed).toHaveLength(10);
    expect(failed.every((e) => e.type === "attempt.failed" && !e.countedForHealth)).toBe(true);
    expect(countedFor(guard, "razorpay", "upi")).toBe(0);
  });

  it("retry goes to the other gateway", async () => {
    const { guard, rp, events } = setup();
    const first = await guard.createPayment(input());
    expect(first.gateway).toBe("razorpay");
    rp.fetchStatus.mockResolvedValue({ status: "failed", classification: "customer" });

    const retry = await guard.createPayment(input("upi", { retryOf: first.attemptId }));
    expect(retry.gateway).toBe("cashfree");
    expect(retry.attemptId).not.toBe(first.attemptId);
    expect(rp.fetchStatus).toHaveBeenCalledWith("razorpay_ref_1");
    expect(events).toContainEqual({
      type: "route.failover",
      method: "upi",
      from: "razorpay",
      to: "cashfree",
      why: "retry",
    });
    expect(events.filter((e) => e.type === "attempt.created").at(-1)).toMatchObject({
      reason: "retry",
    });
  });

  it("retry refused when previous attempt is paid", async () => {
    const { guard, rp } = setup();
    const first = await guard.createPayment(input());
    rp.fetchStatus.mockResolvedValue({ status: "paid" });
    const err = await guard
      .createPayment(input("upi", { retryOf: first.attemptId }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryNotAllowedError);
    expect((err as RetryNotAllowedError).reason).toBe("paid");
    expect(rp.createOrder).toHaveBeenCalledTimes(1);
  });

  it("retry refused when previous attempt is pending", async () => {
    const { guard, rp, cf } = setup();
    const first = await guard.createPayment(input());
    rp.fetchStatus.mockResolvedValue({ status: "pending" });
    const err = await guard
      .createPayment(input("upi", { retryOf: first.attemptId }))
      .catch((e: unknown) => e);
    expect((err as RetryNotAllowedError).reason).toBe("pending");
    expect(cf.createOrder).not.toHaveBeenCalled();
  });

  it("retry refused when previous attempt status lookup throws", async () => {
    const { guard, rp, cf } = setup();
    const first = await guard.createPayment(input());
    rp.fetchStatus.mockRejectedValue(new GatewayRequestError("razorpay", 503, "gateway", "down"));
    const err = await guard
      .createPayment(input("upi", { retryOf: first.attemptId }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryNotAllowedError);
    expect((err as RetryNotAllowedError).reason).toBe("status-unknown");
    expect(cf.createOrder).not.toHaveBeenCalled();
  });

  it("retry refused for an unknown attempt", async () => {
    const { guard, rp } = setup();
    const err = await guard
      .createPayment(input("upi", { retryOf: "att_nope" }))
      .catch((e: unknown) => e);
    expect((err as RetryNotAllowedError).reason).toBe("unknown-attempt");
    expect(rp.createOrder).not.toHaveBeenCalled();
  });

  it("retry refused when another attempt of the order is already paid", async () => {
    const { guard, rp } = setup();
    const a = await guard.createPayment(input());
    rp.fetchStatus.mockResolvedValue({ status: "failed" });
    const b = await guard.createPayment(input("upi", { retryOf: a.attemptId }));
    await guard.verifyPayment(b.attemptId, {}); // paid
    const err = await guard
      .createPayment(input("upi", { retryOf: b.attemptId }))
      .catch((e: unknown) => e);
    expect((err as RetryNotAllowedError).reason).toBe("paid");
  });

  it("retrying the same attempt twice is refused as superseded", async () => {
    const { guard, rp, cf } = setup();
    const a = await guard.createPayment(input());
    rp.fetchStatus.mockResolvedValue({ status: "failed" });
    const b = await guard.createPayment(input("upi", { retryOf: a.attemptId }));
    expect(b.gateway).toBe("cashfree");
    const err = await guard
      .createPayment(input("upi", { retryOf: a.attemptId }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryNotAllowedError);
    expect((err as RetryNotAllowedError).reason).toBe("superseded");
    expect(rp.createOrder).toHaveBeenCalledTimes(1);
    expect(cf.createOrder).toHaveBeenCalledTimes(1);
  });

  it("concurrent retries of the same attempt: exactly one succeeds", async () => {
    const { guard, rp, cf } = setup();
    const a = await guard.createPayment(input());
    rp.fetchStatus.mockResolvedValue({ status: "failed" });
    const results = await Promise.allSettled([
      guard.createPayment(input("upi", { retryOf: a.attemptId })),
      guard.createPayment(input("upi", { retryOf: a.attemptId })),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    const reason = (refused[0] as PromiseRejectedResult).reason as RetryNotAllowedError;
    expect(reason).toBeInstanceOf(RetryNotAllowedError);
    expect(reason.reason).toBe("in-progress");
    expect(cf.createOrder).toHaveBeenCalledTimes(1);
    expect(rp.fetchStatus).toHaveBeenCalledTimes(1);
  });

  it("the in-flight lock is released after a refused retry", async () => {
    const { guard, rp } = setup();
    const a = await guard.createPayment(input());
    rp.fetchStatus.mockResolvedValueOnce({ status: "pending" });
    await expect(guard.createPayment(input("upi", { retryOf: a.attemptId }))).rejects.toMatchObject(
      { reason: "pending" },
    );
    rp.fetchStatus.mockResolvedValueOnce({ status: "failed" });
    const b = await guard.createPayment(input("upi", { retryOf: a.attemptId }));
    expect(b.gateway).toBe("cashfree");
  });

  it("a paid confirmation arriving during the status lookup refuses the retry", async () => {
    const { guard, rp, cf } = setup();
    const a = await guard.createPayment(input());
    let release: () => void = () => {};
    rp.fetchStatus.mockImplementationOnce(
      () =>
        new Promise<StatusResult>((resolve) => {
          release = () => resolve({ status: "failed" }); // stale view
        }),
    );
    const retry = guard.createPayment(input("upi", { retryOf: a.attemptId }));
    await Promise.resolve();
    guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "paid"), good);
    release();
    await expect(retry).rejects.toMatchObject({ reason: "paid" });
    expect(cf.createOrder).not.toHaveBeenCalled();
  });

  it("a new payment for an order with a creation in flight is refused as in-progress", async () => {
    const { guard, rp } = setup();
    const first = guard.createPayment(input());
    const err = await guard.createPayment(input()).catch((e: unknown) => e);
    expect((err as RetryNotAllowedError).reason).toBe("in-progress");
    await expect(first).resolves.toMatchObject({ gateway: "razorpay" });
    expect(rp.createOrder).toHaveBeenCalledTimes(1);
  });

  it("a new payment without retryOf for an order that has an attempt is refused as superseded", async () => {
    const { guard, rp } = setup();
    await guard.createPayment(input());
    const err = await guard.createPayment(input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryNotAllowedError);
    expect((err as RetryNotAllowedError).reason).toBe("superseded");
    expect(rp.createOrder).toHaveBeenCalledTimes(1);
    // Other orders are unaffected.
    await expect(guard.createPayment(input("upi", { orderId: "order_2" }))).resolves.toBeDefined();
  });

  it("emits route.all-down when nothing is usable", async () => {
    const { guard, rp, cf, events } = setup();
    rp.verifyCallback.mockResolvedValue({ status: "failed", classification: "gateway" });
    cf.verifyCallback.mockResolvedValue({ status: "failed", classification: "gateway" });
    for (let i = 0; i < 5; i++) {
      const r = await guard.createPayment(input("upi", { orderId: `r_${i}` }));
      await guard.verifyPayment(r.attemptId, {});
    }
    // razorpay:upi is down now; the next five go to cashfree and take it down too.
    for (let i = 0; i < 5; i++) {
      const c = await guard.createPayment(input("upi", { orderId: `c_${i}` }));
      expect(c.gateway).toBe("cashfree");
      await guard.verifyPayment(c.attemptId, {});
    }
    expect(events.some((e) => e.type === "route.all-down")).toBe(false);

    const res = await guard.createPayment(input("upi", { orderId: "x" }));
    expect(events).toContainEqual({ type: "route.all-down", method: "upi", chosen: res.gateway });
    expect(events.filter((e) => e.type === "attempt.created").at(-1)).toMatchObject({
      reason: "all-down",
    });

    // Retry when every gateway is down: all-down, not retry.
    rp.fetchStatus.mockResolvedValue({ status: "failed" });
    cf.fetchStatus.mockResolvedValue({ status: "failed" });
    const before = events.filter((e) => e.type === "route.all-down").length;
    const retry = await guard.createPayment(input("upi", { orderId: "x", retryOf: res.attemptId }));
    const allDown = events.filter((e) => e.type === "route.all-down");
    expect(allDown).toHaveLength(before + 1);
    expect(allDown.at(-1)).toEqual({
      type: "route.all-down",
      method: "upi",
      chosen: retry.gateway,
    });
    expect(events.filter((e) => e.type === "attempt.created").at(-1)).toMatchObject({
      reason: "all-down",
    });
    expect(
      events.some((e) => e.type === "route.failover" && e.why === "retry" && e.method === "upi"),
    ).toBe(false);
  });

  it("retry of a cashfree attempt cancels the old order before routing", async () => {
    const { guard, rp, cf } = setup();
    rp.createOrder.mockRejectedValueOnce(new GatewayRequestError("razorpay", 500, "gateway", "x"));
    const first = await guard.createPayment(input());
    expect(first.gateway).toBe("cashfree");
    const order: string[] = [];
    cf.fetchStatus.mockImplementation(async () => {
      order.push("fetchStatus");
      return { status: "failed" };
    });
    cf.cancelOrder = vi.fn(async () => {
      order.push("cancel");
    });
    rp.createOrder.mockImplementationOnce(async (i: CreateOrderInput) => {
      order.push("create");
      return {
        gatewayRef: "r",
        checkout: {
          gateway: "razorpay",
          keyId: "k",
          orderId: "r",
          amountMinor: i.amountMinor,
          currency: "INR",
          method: i.method,
        },
      };
    });
    const retry = await guard.createPayment(input("upi", { retryOf: first.attemptId }));
    expect(retry.gateway).toBe("razorpay");
    expect(cf.cancelOrder).toHaveBeenCalledWith("cashfree_ref_1");
    expect(order).toEqual(["fetchStatus", "cancel", "create"]);
  });

  it("retry refused when cancel reports the order was paid meanwhile", async () => {
    const { guard, rp, cf } = setup();
    rp.createOrder.mockRejectedValueOnce(new GatewayRequestError("razorpay", 500, "gateway", "x"));
    const first = await guard.createPayment(input());
    cf.fetchStatus.mockResolvedValueOnce({ status: "failed" }).mockResolvedValueOnce({
      status: "paid",
    });
    cf.cancelOrder = vi.fn(async () => {
      throw new GatewayRequestError("cashfree", 200, "unknown", "order_paid");
    });
    const err = await guard
      .createPayment(input("upi", { retryOf: first.attemptId }))
      .catch((e: unknown) => e);
    expect((err as RetryNotAllowedError).reason).toBe("paid");
    expect(cf.fetchStatus).toHaveBeenCalledTimes(2);
    expect(rp.createOrder).toHaveBeenCalledTimes(1);
  });

  it("retry refused as status-unknown when cancel fails otherwise", async () => {
    const { guard, rp, cf } = setup();
    rp.createOrder.mockRejectedValueOnce(new GatewayRequestError("razorpay", 500, "gateway", "x"));
    const first = await guard.createPayment(input());
    cf.cancelOrder = vi.fn(async () => {
      throw new GatewayRequestError("cashfree", 200, "unknown", "not_terminated");
    });
    const err = await guard
      .createPayment(input("upi", { retryOf: first.attemptId }))
      .catch((e: unknown) => e);
    expect((err as RetryNotAllowedError).reason).toBe("status-unknown");
    expect(rp.createOrder).toHaveBeenCalledTimes(1);
  });

  it("createOrder error on first gateway fails over at creation", async () => {
    const { guard, rp, cf, events } = setup();
    rp.createOrder.mockRejectedValueOnce(
      new GatewayRequestError("razorpay", 502, "gateway", "bad gateway"),
    );
    const res = await guard.createPayment(input());
    expect(res.gateway).toBe("cashfree");
    expect(countedFor(guard, "razorpay", "upi")).toBe(1);
    expect(events).toContainEqual({
      type: "route.failover",
      method: "upi",
      from: "razorpay",
      to: "cashfree",
      why: "create-error",
    });
    // A fresh attemptId per gateway order: never reused.
    const rpId = rp.createOrder.mock.calls[0]?.[0].attemptId;
    const cfId = cf.created[0]?.attemptId;
    expect(rpId).toBeDefined();
    expect(rpId).not.toBe(cfId);
    expect(res.attemptId).toBe(cfId);
    expect(events.filter((e) => e.type === "attempt.created")).toHaveLength(1);
  });

  it("rethrows the last error when every gateway fails at creation", async () => {
    const { guard, rp, cf } = setup();
    rp.createOrder.mockRejectedValueOnce(new GatewayRequestError("razorpay", 502, "gateway", "a"));
    const last = new GatewayRequestError("cashfree", 503, "gateway", "b");
    cf.createOrder.mockRejectedValueOnce(last);
    await expect(guard.createPayment(input())).rejects.toBe(last);
  });

  it("adapter ValidationError propagates without health record or failover", async () => {
    const { guard, rp, cf } = setup();
    rp.createOrder.mockRejectedValueOnce(new ValidationError("amount too small"));
    await expect(guard.createPayment(input())).rejects.toBeInstanceOf(ValidationError);
    expect(cf.createOrder).not.toHaveBeenCalled();
    expect(countedFor(guard, "razorpay", "upi")).toBe(0);
  });

  it("callback then webhook for the same attempt counts once", async () => {
    const { guard, events } = setup();
    const { attemptId } = await guard.createPayment(input());
    const outcome = await guard.verifyPayment(attemptId, { sig: "x" });
    expect(outcome.status).toBe("paid");
    guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "paid"), good);
    await guard.verifyPayment(attemptId, { sig: "x" });
    expect(countedFor(guard, "razorpay", "upi")).toBe(1);
    expect(events.filter((e) => e.type === "attempt.succeeded")).toHaveLength(1);
  });

  it("unknown webhook returns the event, emits webhook.unmatched, health unchanged", async () => {
    const { guard, events } = setup();
    const before = guard.health();
    const ev = guard.verifyWebhook("razorpay", webhook("nobody", "failed", "gateway"), good);
    expect(ev.gatewayRef).toBe("nobody");
    expect(events).toEqual([{ type: "webhook.unmatched", event: ev }]);
    expect(guard.health()).toEqual(before);
  });

  it("invalid webhook signature throws and health unchanged", async () => {
    const { guard, events } = setup();
    await guard.createPayment(input());
    const before = guard.health();
    expect(() =>
      guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "failed", "gateway"), {
        "x-sig": "bad",
      }),
    ).toThrow(InvalidSignatureError);
    expect(guard.health()).toEqual(before);
    expect(events.filter((e) => e.type !== "attempt.created")).toEqual([]);
  });

  it("validation errors make no adapter calls", async () => {
    const { guard, rp, cf } = setup();
    const bad = [
      { ...input(), orderId: "" },
      { ...input(), amountMinor: 0 },
      { ...input(), amountMinor: 10.5 },
      { ...input(), currency: "USD" as "INR" },
      { ...input(), method: "cash" as PaymentMethod },
      { ...input(), customer: { id: "c", phone: "" } },
    ];
    for (const b of bad) {
      await expect(guard.createPayment(b)).rejects.toBeInstanceOf(ValidationError);
    }
    for (const a of [rp, cf]) {
      expect(a.createOrder).not.toHaveBeenCalled();
      expect(a.fetchStatus).not.toHaveBeenCalled();
    }
  });

  it("webhook failure records health and emits attempt.failed once", async () => {
    const { guard, events } = setup();
    await guard.createPayment(input());
    guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "failed", "gateway"), good);
    guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "failed", "gateway"), good);
    const failed = events.filter((e) => e.type === "attempt.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ classification: "gateway", countedForHealth: true });
    expect(countedFor(guard, "razorpay", "upi")).toBe(1);
  });

  it("a paid report after a failed one still counts as paid", async () => {
    const { guard, events } = setup();
    const { attemptId } = await guard.createPayment(input());
    guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "failed", "customer"), good);
    guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "paid"), good);
    guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "paid"), good);
    const succeeded = events.filter((e) => e.type === "attempt.succeeded");
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0]).toMatchObject({ attempt: { attemptId, final: "paid" } });
  });

  it("emits order.multiple-payments when a second attempt of an order is paid", async () => {
    const { guard, rp, events } = setup();
    const a = await guard.createPayment(input());
    rp.fetchStatus.mockResolvedValue({ status: "failed" });
    const b = await guard.createPayment(input("upi", { retryOf: a.attemptId }));
    const other = await guard.createPayment(input("upi", { orderId: "order_2" }));
    await guard.verifyPayment(other.attemptId, {});
    await guard.verifyPayment(b.attemptId, {});
    expect(events.filter((e) => e.type === "order.multiple-payments")).toHaveLength(0);

    // The original razorpay order gets paid late (Razorpay orders can't be cancelled).
    guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "paid"), good);
    const multi = events.filter((e) => e.type === "order.multiple-payments");
    expect(multi).toHaveLength(1);
    const m = multi[0] as Extract<GuardEvent, { type: "order.multiple-payments" }>;
    expect(m.orderId).toBe("order_1");
    expect(m.attempts.map((x) => x.attemptId).sort()).toEqual([a.attemptId, b.attemptId].sort());
    // Duplicate report of the same paid attempt does not re-emit.
    guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "paid"), good);
    expect(events.filter((e) => e.type === "order.multiple-payments")).toHaveLength(1);
  });

  it("a throwing listener doesn't break the flow or other listeners", async () => {
    const errors: Array<[unknown, GuardEvent]> = [];
    const { guard, events } = setup({ onListenerError: (e, ev) => errors.push([e, ev]) });
    const boom = new Error("listener boom");
    guard.on("attempt.created", () => {
      throw boom;
    });
    const seen: string[] = [];
    guard.on("attempt.created", (e) => seen.push(e.attempt.attemptId));
    const res = await guard.createPayment(input());
    expect(res.gateway).toBe("razorpay");
    expect(seen).toEqual([res.attemptId]);
    expect(events.filter((e) => e.type === "attempt.created")).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.[0]).toBe(boom);
    expect(errors[0]?.[1].type).toBe("attempt.created");
  });

  it("a throwing health.changed listener doesn't break outcome handling", async () => {
    const errors: unknown[] = [];
    const { guard, rp } = setup({ onListenerError: (e) => errors.push(e) });
    guard.on("health.changed", () => {
      throw new Error("x");
    });
    rp.verifyCallback.mockResolvedValue({ status: "failed", classification: "gateway" });
    for (let i = 0; i < 5; i++) {
      const { attemptId } = await guard.createPayment(input("upi", { orderId: `o_${i}` }));
      await expect(guard.verifyPayment(attemptId, {})).resolves.toMatchObject({
        status: "failed",
      });
    }
    expect(errors.length).toBeGreaterThan(0);
  });

  it("on() returns an unsubscribe function", async () => {
    const { guard } = setup();
    const seen: unknown[] = [];
    const off = guard.on("attempt.created", (e) => seen.push(e));
    off();
    await guard.createPayment(input());
    expect(seen).toEqual([]);
  });

  it("verifyPayment rejects an unknown attempt", async () => {
    const { guard } = setup();
    await expect(guard.verifyPayment("att_missing", {})).rejects.toBeInstanceOf(ValidationError);
  });

  describe("dismissed checkout (status created)", () => {
    it("cashfree: cancels the old order, then the retry proceeds", async () => {
      const { guard, rp, cf } = setup();
      rp.createOrder.mockRejectedValueOnce(
        new GatewayRequestError("razorpay", 500, "gateway", "x"),
      );
      const first = await guard.createPayment(input());
      expect(first.gateway).toBe("cashfree");
      const order: string[] = [];
      cf.fetchStatus.mockImplementation(async () => {
        order.push("fetchStatus");
        return { status: "created" };
      });
      cf.cancelOrder = vi.fn(async () => {
        order.push("cancel");
      });
      const retry = await guard.createPayment(input("upi", { retryOf: first.attemptId }));
      expect(retry.gateway).toBe("razorpay");
      expect(cf.cancelOrder).toHaveBeenCalledWith("cashfree_ref_1");
      expect(order).toEqual(["fetchStatus", "cancel"]);
    });

    it("razorpay: the retry proceeds without a cancel", async () => {
      const { guard, rp, events } = setup();
      const first = await guard.createPayment(input());
      rp.fetchStatus.mockResolvedValue({ status: "created" });
      const retry = await guard.createPayment(input("upi", { retryOf: first.attemptId }));
      expect(retry.gateway).toBe("cashfree");
      // Nothing was paid or failed: no outcome, no health record.
      expect(events.some((e) => e.type === "attempt.failed")).toBe(false);
      expect(countedFor(guard, "razorpay", "upi")).toBe(0);
    });
  });

  describe("resume", () => {
    const refusal = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (e) {
        return e;
      }
      return undefined;
    };

    it("returns the stored checkout of the latest live attempt", async () => {
      const { guard, rp } = setup();
      const first = await guard.createPayment(input());
      expect(guard.resume(first.attemptId)).toEqual(first);
      expect(rp.createOrder).toHaveBeenCalledTimes(1);
      expect(rp.fetchStatus).not.toHaveBeenCalled();
    });

    it("refuses an unknown or expired attempt as unknown-attempt", async () => {
      const { guard, clock } = setup();
      const unknown = refusal(() => guard.resume("att_nope"));
      expect(unknown).toBeInstanceOf(RetryNotAllowedError);
      expect((unknown as RetryNotAllowedError).reason).toBe("unknown-attempt");
      const first = await guard.createPayment(input());
      clock.t += 86_400_001;
      const expired = refusal(() => guard.resume(first.attemptId));
      expect(expired).toBeInstanceOf(RetryNotAllowedError);
      expect((expired as RetryNotAllowedError).reason).toBe("unknown-attempt");
    });

    it("refuses a paid attempt", async () => {
      const { guard } = setup();
      const first = await guard.createPayment(input());
      await guard.verifyPayment(first.attemptId, {}); // paid
      expect(refusal(() => guard.resume(first.attemptId))).toMatchObject({ reason: "paid" });
    });

    it("refuses a failed attempt as superseded", async () => {
      const { guard } = setup();
      const first = await guard.createPayment(input());
      guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "failed", "customer"), good);
      expect(refusal(() => guard.resume(first.attemptId))).toMatchObject({ reason: "superseded" });
    });

    it("refuses an attempt that was retried", async () => {
      const { guard, rp } = setup();
      const first = await guard.createPayment(input());
      rp.fetchStatus.mockResolvedValue({ status: "created" });
      const retry = await guard.createPayment(input("upi", { retryOf: first.attemptId }));
      expect(refusal(() => guard.resume(first.attemptId))).toMatchObject({ reason: "superseded" });
      expect(guard.resume(retry.attemptId)).toEqual(retry);
    });

    it("refuses while a payment for the order is being created", async () => {
      const { guard, rp } = setup();
      const first = await guard.createPayment(input());
      rp.fetchStatus.mockResolvedValue({ status: "failed" });
      const retry = guard.createPayment(input("upi", { retryOf: first.attemptId }));
      expect(refusal(() => guard.resume(first.attemptId))).toMatchObject({
        reason: "in-progress",
      });
      await retry;
    });

    it("refuses a cancelled attempt whose retry could not be created", async () => {
      const { guard, rp, cf } = setup();
      rp.createOrder.mockRejectedValueOnce(
        new GatewayRequestError("razorpay", 500, "gateway", "x"),
      );
      const first = await guard.createPayment(input());
      cf.fetchStatus.mockResolvedValue({ status: "created" });
      cf.cancelOrder = vi.fn(async () => {});
      rp.createOrder.mockRejectedValueOnce(
        new GatewayRequestError("razorpay", 500, "gateway", "x"),
      );
      cf.createOrder.mockRejectedValueOnce(
        new GatewayRequestError("cashfree", 500, "gateway", "y"),
      );
      await expect(
        guard.createPayment(input("upi", { retryOf: first.attemptId })),
      ).rejects.toBeInstanceOf(GatewayRequestError);
      expect(refusal(() => guard.resume(first.attemptId))).toMatchObject({ reason: "superseded" });
    });

    it("event payloads do not carry the checkout", async () => {
      const { guard, events } = setup();
      await guard.createPayment(input());
      const created = events.find((e) => e.type === "attempt.created");
      expect(created).toBeDefined();
      expect(Object.keys((created as { attempt: object }).attempt)).not.toContain("checkout");
    });
  });

  describe("retry settles the previous attempt from the status lookup", () => {
    it("a fetched gateway failure counts once; a later webhook adds nothing", async () => {
      const { guard, rp, events } = setup();
      const first = await guard.createPayment(input());
      rp.fetchStatus.mockResolvedValue({
        status: "failed",
        classification: "gateway",
        reason: "server_error",
      });
      await guard.createPayment(input("upi", { retryOf: first.attemptId }));
      expect(countedFor(guard, "razorpay", "upi")).toBe(1);
      const failed = events.filter((e) => e.type === "attempt.failed");
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({
        attempt: { attemptId: first.attemptId, final: "failed" },
        classification: "gateway",
        reason: "server_error",
        countedForHealth: true,
      });

      guard.verifyWebhook("razorpay", webhook("razorpay_ref_1", "failed", "gateway"), good);
      expect(countedFor(guard, "razorpay", "upi")).toBe(1);
      expect(events.filter((e) => e.type === "attempt.failed")).toHaveLength(1);
    });

    it("a fetched customer failure doesn't affect health", async () => {
      const { guard, rp, events } = setup();
      const first = await guard.createPayment(input());
      rp.fetchStatus.mockResolvedValue({ status: "failed", classification: "customer" });
      await guard.createPayment(input("upi", { retryOf: first.attemptId }));
      expect(countedFor(guard, "razorpay", "upi")).toBe(0);
      expect(events.filter((e) => e.type === "attempt.failed")).toMatchObject([
        { classification: "customer", countedForHealth: false },
      ]);
    });

    it("a fetched paid status settles the attempt as paid", async () => {
      const { guard, rp, events } = setup();
      const first = await guard.createPayment(input());
      rp.fetchStatus.mockResolvedValue({ status: "paid" });
      await expect(
        guard.createPayment(input("upi", { retryOf: first.attemptId })),
      ).rejects.toMatchObject({ reason: "paid" });
      expect(events.filter((e) => e.type === "attempt.succeeded")).toHaveLength(1);
      expect(countedFor(guard, "razorpay", "upi")).toBe(1);
    });
  });

  it("a second retry after an all-gateways-failed create doesn't cancel again", async () => {
    const { guard, rp, cf } = setup();
    rp.createOrder.mockRejectedValueOnce(new GatewayRequestError("razorpay", 500, "gateway", "x"));
    const first = await guard.createPayment(input());
    cf.fetchStatus.mockResolvedValue({ status: "failed" });
    cf.cancelOrder = vi.fn(async () => {});
    rp.createOrder.mockRejectedValueOnce(new GatewayRequestError("razorpay", 500, "gateway", "x"));
    cf.createOrder.mockRejectedValueOnce(new GatewayRequestError("cashfree", 500, "gateway", "y"));
    await expect(
      guard.createPayment(input("upi", { retryOf: first.attemptId })),
    ).rejects.toBeInstanceOf(GatewayRequestError);
    expect(cf.cancelOrder).toHaveBeenCalledTimes(1);

    const retry = await guard.createPayment(input("upi", { retryOf: first.attemptId }));
    expect(retry).toBeDefined();
    expect(cf.cancelOrder).toHaveBeenCalledTimes(1);
  });
});
