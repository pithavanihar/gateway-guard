// Payment statuses: https://www.cashfree.com/docs/api-reference/payments/previous/v2023-08-01/payments/get-payments-for-order
// Error structure:  https://www.cashfree.com/docs/api-reference/payments/errors
// Reason/source list ("Payment Error List" linked from the errors page):
//   https://gocashassets.s3.ap-south-1.amazonaws.com/repostmancollection/Error+List.xlsx
import { describe, expect, it } from "vitest";
import {
  CASHFREE_CUSTOMER_STATUSES,
  CASHFREE_REASON_CLASSIFICATION,
  CASHFREE_SOURCE_CLASSIFICATION,
  CASHFREE_SOURCE_DECIDED_REASONS,
  classifyCashfree,
} from "../../../src/adapters/cashfree/classify.js";
import type { Classification } from "../../../src/types.js";

describe("classifyCashfree", () => {
  it("USER_DROPPED is a customer failure", () => {
    expect(classifyCashfree({ payment_status: "USER_DROPPED" })).toBe("customer");
    // Even if Cashfree attaches a provider-side source, the customer abandoned the flow.
    expect(
      classifyCashfree({ payment_status: "USER_DROPPED", error_details: { error_source: "bank" } }),
    ).toBe("customer");
  });

  it("CANCELLED is a customer failure", () => {
    expect(classifyCashfree({ payment_status: "CANCELLED" })).toBe("customer");
  });

  it("FAILED with bank source is a gateway failure", () => {
    expect(
      classifyCashfree({
        payment_status: "FAILED",
        error_details: {
          error_code: "TRANSACTION_DECLINED",
          error_reason: "bank_rejected",
          error_source: "bank",
        },
      }),
    ).toBe("gateway");
  });

  it.each<[string | undefined, Classification]>([
    ["customer", "customer"],
    ["bank", "gateway"],
    ["cashfree", "gateway"],
    ["gateway", "gateway"],
    ["merchant", "unknown"],
    ["something_new", "unknown"],
    [undefined, "unknown"],
  ])("FAILED, unlisted reason, source %s → %s", (error_source, expected) => {
    expect(
      classifyCashfree({
        payment_status: "FAILED",
        error_details: { error_reason: "brand_new_reason", error_source },
      }),
    ).toBe(expected);
  });

  it.each<[string, Classification]>([
    ["user_dropped", "customer"],
    ["customer_cancelled", "customer"],
    ["insufficient_funds", "customer"],
    ["invalid_otp", "customer"],
    ["invalid_pin", "customer"],
    ["expired_card", "customer"],
    ["auth_declined", "customer"],
    ["bank_offline", "gateway"],
    ["issuer_timeout", "gateway"],
    ["technical_error", "gateway"],
    ["network_error", "gateway"],
    ["merchant_transaction_limit", "unknown"],
    ["currency_not_supported", "unknown"],
  ])("FAILED with reason %s and no source → %s", (error_reason, expected) => {
    expect(classifyCashfree({ payment_status: "FAILED", error_details: { error_reason } })).toBe(
      expected,
    );
  });

  it("the reason wins over the source", () => {
    expect(
      classifyCashfree({
        payment_status: "FAILED",
        error_details: { error_reason: "insufficient_funds", error_source: "bank" },
      }),
    ).toBe("customer");
    expect(
      classifyCashfree({
        payment_status: "FAILED",
        error_details: { error_reason: "bank_server_downtime", error_source: "customer" },
      }),
    ).toBe("gateway");
  });

  it("reasons Cashfree reports with conflicting sources are decided by the source", () => {
    for (const { reason } of CASHFREE_SOURCE_DECIDED_REASONS) {
      const c = (error_source?: string) =>
        classifyCashfree({
          payment_status: "FAILED",
          error_details: { error_reason: reason, error_source },
        });
      expect(c("customer")).toBe("customer");
      expect(c("bank")).toBe("gateway");
      expect(c("merchant")).toBe("unknown");
      expect(c(undefined)).toBe("unknown");
    }
  });

  it("FAILED without error details is unknown", () => {
    expect(classifyCashfree({ payment_status: "FAILED" })).toBe("unknown");
  });

  it("tables are exported data with every classification represented", () => {
    expect(CASHFREE_CUSTOMER_STATUSES).toEqual(["USER_DROPPED", "CANCELLED"]);
    const values = new Set(CASHFREE_REASON_CLASSIFICATION.map((r) => r.classification));
    expect(values).toEqual(new Set(["customer", "gateway", "unknown"]));
    const reasons = CASHFREE_REASON_CLASSIFICATION.map((r) => r.reason);
    expect(new Set(reasons).size).toBe(reasons.length);
    expect(CASHFREE_SOURCE_CLASSIFICATION.map((r) => r.source)).toEqual([
      "customer",
      "bank",
      "cashfree",
      "gateway",
      "merchant",
    ]);
    for (const { reason } of CASHFREE_SOURCE_DECIDED_REASONS) {
      expect(reasons).not.toContain(reason);
    }
  });
});
