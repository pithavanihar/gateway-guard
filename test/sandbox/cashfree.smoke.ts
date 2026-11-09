import { describe, expect, it } from "vitest";
import { CashfreeAdapter } from "../../src/adapters/cashfree/CashfreeAdapter.js";
import { env } from "./env.js";

const appId = env("CASHFREE_APP_ID");
const secretKey = env("CASHFREE_SECRET_KEY");

describe.skipIf(!appId || !secretKey)("Cashfree sandbox smoke", () => {
  it("creates an order and returns a payment session id", async () => {
    const adapter = new CashfreeAdapter(
      { appId: appId!, secretKey: secretKey!, env: "sandbox" },
      { fetch, timeoutMs: 15_000 },
    );
    const { checkout } = await adapter.createOrder({
      attemptId: `smoke_${Date.now()}`,
      orderId: `smoke_order_${Date.now()}`,
      amountMinor: 10_000,
      currency: "INR",
      method: "upi",
      customer: { id: "smoke", phone: "9999999999" },
    });
    expect(checkout.gateway).toBe("cashfree");
    if (checkout.gateway !== "cashfree") return;
    expect(checkout.paymentSessionId).toBeTruthy();
  });
});
