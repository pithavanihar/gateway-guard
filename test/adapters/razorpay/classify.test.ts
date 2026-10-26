// Reason list: https://razorpay.com/docs/errors/payments/list/
// Source values: https://razorpay.com/docs/errors/payments/payment-methods-error-parameters/
import { describe, expect, it } from "vitest";
import {
  RAZORPAY_REASON_CLASSIFICATION,
  RAZORPAY_SOURCE_CLASSIFICATION,
  classifyRazorpay,
} from "../../../src/adapters/razorpay/classify.js";
import type { Classification } from "../../../src/types.js";

describe("classifyRazorpay", () => {
  it.each<[string, Classification]>([
    ["payment_cancelled", "customer"],
    ["payment_timed_out", "customer"],
    ["incorrect_otp", "customer"],
    ["insufficient_funds", "customer"],
    ["card_declined", "customer"],
    ["incorrect_pin", "customer"],
    ["bank_technical_error", "gateway"],
    ["gateway_technical_error", "gateway"],
    ["server_error", "gateway"],
    ["issuer_technical_error", "gateway"],
    ["payment_method_not_enabled", "unknown"],
    ["input_validation_failed", "unknown"],
    ["merchant_not_activated", "unknown"],
  ])("reason %s → %s", (reason, expected) => {
    expect(classifyRazorpay({ reason })).toBe(expected);
  });

  it("the reason wins over the source", () => {
    // A customer cancellation reported with a bank source must still not hurt the gateway.
    expect(classifyRazorpay({ source: "bank", reason: "payment_cancelled" })).toBe("customer");
    expect(classifyRazorpay({ source: "customer", reason: "gateway_technical_error" })).toBe(
      "gateway",
    );
  });

  it.each<[string, Classification]>([
    ["customer", "customer"],
    ["bank", "gateway"],
    ["gateway", "gateway"],
    ["internal", "gateway"],
    ["issuer_bank", "gateway"],
    ["business", "unknown"],
    ["something_new", "unknown"],
  ])("fallback: unlisted reason with source %s → %s", (source, expected) => {
    expect(classifyRazorpay({ source, reason: "payment_failed" })).toBe(expected);
  });

  it("falls back to the error code, then unknown", () => {
    expect(classifyRazorpay({ code: "SERVER_ERROR" })).toBe("gateway");
    expect(classifyRazorpay({ code: "GATEWAY_ERROR" })).toBe("gateway");
    expect(classifyRazorpay({ code: "BAD_REQUEST_ERROR" })).toBe("unknown");
    expect(classifyRazorpay({})).toBe("unknown");
  });

  it("tables are exported data with every classification represented", () => {
    const values = new Set(RAZORPAY_REASON_CLASSIFICATION.map((r) => r.classification));
    expect(values).toEqual(new Set(["customer", "gateway", "unknown"]));
    const reasons = RAZORPAY_REASON_CLASSIFICATION.map((r) => r.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(RAZORPAY_SOURCE_CLASSIFICATION.length).toBeGreaterThan(0);
  });
});
