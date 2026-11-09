import { describe, expect, it } from "vitest";
import { RazorpayAdapter } from "../../src/adapters/razorpay/RazorpayAdapter.js";
import { env } from "./env.js";

const keyId = env("RAZORPAY_KEY_ID");
const keySecret = env("RAZORPAY_KEY_SECRET");

describe.skipIf(!keyId || !keySecret)("Razorpay test-mode smoke", () => {
  it("creates an order and reads it back as created", async () => {
    const adapter = new RazorpayAdapter(
      // The webhook secret is not exercised here; the constructor just requires one.
      { keyId: keyId!, keySecret: keySecret!, webhookSecret: "unused-in-smoke" },
      { fetch, timeoutMs: 15_000 },
    );
    const { gatewayRef, checkout } = await adapter.createOrder({
      attemptId: `smoke_${Date.now()}`,
      orderId: `smoke_order_${Date.now()}`,
      amountMinor: 10_000,
      currency: "INR",
      method: "upi",
      customer: { id: "smoke", phone: "9999999999" },
    });
    expect(gatewayRef).toMatch(/^order_/);
    expect(checkout.gateway).toBe("razorpay");
    expect((await adapter.fetchStatus(gatewayRef)).status).toBe("created");
  });
});
