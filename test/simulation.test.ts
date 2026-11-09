import { describe, expect, it, vi } from "vitest";
import { GatewayGuard, type GuardEvent } from "../src/GatewayGuard.js";
import type { CreateOrderInput, GatewayAdapter, StatusResult } from "../src/adapters/Adapter.js";
import type { Checkout, GatewayName, Outcome, PaymentMethod } from "../src/types.js";

/** A gateway whose verification result the test controls. */
function fakeGateway(name: GatewayName) {
  let n = 0;
  const verifyCallback = vi.fn(async (): Promise<Outcome> => ({ status: "paid" }));
  const adapter: GatewayAdapter = {
    name,
    supports: () => true,
    createOrder: async (input: CreateOrderInput) => {
      const gatewayRef = `${name}_${++n}`;
      const checkout: Checkout =
        name === "cashfree"
          ? {
              gateway: "cashfree",
              paymentSessionId: gatewayRef,
              mode: "sandbox",
              method: input.method,
            }
          : {
              gateway: "razorpay",
              keyId: "rzp_test",
              orderId: gatewayRef,
              amountMinor: input.amountMinor,
              currency: "INR",
              method: input.method,
            };
      return { gatewayRef, checkout };
    },
    fetchStatus: async (): Promise<StatusResult> => ({ status: "pending" }),
    verifyCallback,
    verifyWebhook: () => {
      throw new Error("not used in the simulation");
    },
  };
  return { adapter, verifyCallback };
}

describe("failover simulation: a Razorpay netbanking outage", () => {
  const clock = { t: 1_000_000 };
  const rnd = { value: 0.9 }; // >= probeRatio, so no half-open probe is let through
  const razorpay = fakeGateway("razorpay");
  const cashfree = fakeGateway("cashfree");
  const guard = new GatewayGuard({
    gateways: {},
    priority: ["razorpay", "cashfree"],
    adapters: [razorpay.adapter, cashfree.adapter],
    now: () => clock.t,
    random: () => rnd.value,
  });
  const events: GuardEvent[] = [];
  for (const type of ["route.failover", "health.changed"] as const) {
    guard.on(type, (e) => events.push(e));
  }

  let seq = 0;
  const customer = { id: "c1", phone: "9999999999" };
  const pay = (method: PaymentMethod) =>
    guard.createPayment({
      orderId: `order_${++seq}`,
      amountMinor: 50_000,
      currency: "INR",
      method,
      customer,
    });
  const healthOf = (gateway: GatewayName, method: PaymentMethod) =>
    guard.health().find((h) => h.gateway === gateway && h.method === method)?.label;

  it("plays out stage by stage", async () => {
    // 1. Everything is healthy: both methods go to the top-priority gateway, Razorpay.
    expect((await pay("netbanking")).gateway).toBe("razorpay");
    expect((await pay("upi")).gateway).toBe("razorpay");

    // 2. Razorpay netbanking starts returning gateway failures; after 5 the circuit opens.
    razorpay.verifyCallback.mockResolvedValue({ status: "failed", classification: "gateway" });
    for (let i = 0; i < 5; i++) {
      const { attemptId, gateway } = await pay("netbanking");
      expect(gateway).toBe("razorpay");
      await guard.verifyPayment(attemptId, {});
    }
    expect(healthOf("razorpay", "netbanking")).toBe("down");
    expect(healthOf("razorpay", "upi")).toBe("healthy");

    // 3. Netbanking now fails over to Cashfree; UPI is unaffected and stays on Razorpay.
    expect((await pay("netbanking")).gateway).toBe("cashfree");
    expect(events).toContainEqual({
      type: "route.failover",
      method: "netbanking",
      from: "razorpay",
      to: "cashfree",
      why: "unhealthy",
    });
    expect((await pay("upi")).gateway).toBe("razorpay");

    // 4. Customers abandoning UPI payments is not the gateway's fault and never counts.
    razorpay.verifyCallback.mockResolvedValue({ status: "failed", classification: "customer" });
    for (let i = 0; i < 20; i++) {
      const { attemptId } = await pay("upi");
      await guard.verifyPayment(attemptId, {});
    }
    expect(healthOf("razorpay", "upi")).toBe("healthy");

    // 5. After the 60 s cooldown the circuit is half-open ("degraded"); a successful probe
    //    closes it and netbanking returns to Razorpay.
    clock.t += 60_000;
    expect(healthOf("razorpay", "netbanking")).toBe("degraded");
    razorpay.verifyCallback.mockResolvedValue({ status: "paid" });
    rnd.value = 0.1; // below probeRatio: let the probe through
    const probe = await pay("netbanking");
    expect(probe.gateway).toBe("razorpay");
    await guard.verifyPayment(probe.attemptId, {});
    expect(healthOf("razorpay", "netbanking")).toBe("healthy");

    rnd.value = 0.9;
    expect((await pay("netbanking")).gateway).toBe("razorpay");
  });
});
