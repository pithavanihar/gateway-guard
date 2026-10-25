import { describe, expect, it } from "vitest";
import { validatePaymentInput } from "../src/validate.js";
import { ValidationError } from "../src/errors.js";

const base = {
  orderId: "ord_1",
  amountMinor: 49900,
  currency: "INR",
  method: "upi",
  customer: { id: "c1", phone: "9999999999" },
};

describe("validatePaymentInput", () => {
  it("accepts valid input", () => {
    expect(() => validatePaymentInput(base)).not.toThrow();
  });

  it.each([0, -100, 10.5, NaN, Infinity])("rejects amountMinor %s", (amountMinor) => {
    expect(() => validatePaymentInput({ ...base, amountMinor })).toThrow(ValidationError);
  });

  it("rejects non-INR currency", () => {
    expect(() => validatePaymentInput({ ...base, currency: "USD" })).toThrow(ValidationError);
  });

  it("rejects unknown method", () => {
    expect(() => validatePaymentInput({ ...base, method: "wallet" })).toThrow(ValidationError);
  });

  it("rejects empty orderId", () => {
    expect(() => validatePaymentInput({ ...base, orderId: "" })).toThrow(ValidationError);
  });

  it("rejects orderId longer than 40 chars", () => {
    expect(() => validatePaymentInput({ ...base, orderId: "a".repeat(41) })).toThrow(
      ValidationError,
    );
    expect(() => validatePaymentInput({ ...base, orderId: "a".repeat(40) })).not.toThrow();
  });

  it("rejects customer without phone", () => {
    expect(() => validatePaymentInput({ ...base, customer: { id: "c1", phone: "" } })).toThrow(
      ValidationError,
    );
    expect(() => validatePaymentInput({ ...base, customer: { id: "c1" } as never })).toThrow(
      ValidationError,
    );
  });
});
