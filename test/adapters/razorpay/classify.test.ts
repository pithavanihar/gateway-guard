// Reason list: https://razorpay.com/docs/errors/payments/list/
// Source values: https://razorpay.com/docs/errors/payments/payment-methods-error-parameters/
import { describe, expect, it } from "vitest";
import {
  RAZORPAY_REASON_CLASSIFICATION,
  RAZORPAY_SOURCE_CLASSIFICATION,
  RAZORPAY_SOURCE_DECIDED_REASONS,
  classifyRazorpay,
} from "../../../src/adapters/razorpay/classify.js";
import type { Classification } from "../../../src/types.js";

describe("classifyRazorpay", () => {
  it.each<[string, Classification]>([
    ["payment_cancelled", "customer"],
    ["otp_expired", "customer"],
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

  // R9/R10: these reasons mean "customer abandoned" OR "provider did not respond / ACS failed",
  // so the error_source decides; a missing or unlisted source is unknown (no code fallback).
  const sourceCases: [string | undefined, Classification][] = [
    ["customer", "customer"],
    ["bank", "gateway"],
    ["gateway", "gateway"],
    ["issuer", "gateway"],
    ["issuer_bank", "gateway"],
    ["network", "gateway"],
    ["razorpay", "gateway"],
    ["internal", "gateway"],
    ["business", "unknown"],
    ["customer_psp", "unknown"],
    ["something_new", "unknown"],
    [undefined, "unknown"],
  ];
  it.each(
    ["payment_timed_out", "authentication_failed"].flatMap((reason) =>
      sourceCases.map(([source, expected]) => [reason, source, expected] as const),
    ),
  )("source-decided reason %s with source %s → %s", (reason, source, expected) => {
    expect(classifyRazorpay({ reason, source, code: "SERVER_ERROR" })).toBe(expected);
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
    const decided = RAZORPAY_SOURCE_DECIDED_REASONS.map((r) => r.reason);
    expect(decided).toEqual(["payment_timed_out", "authentication_failed"]);
    for (const r of decided) expect(reasons).not.toContain(r);
  });
});
