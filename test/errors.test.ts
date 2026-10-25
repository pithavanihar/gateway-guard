import { describe, expect, it } from "vitest";
import {
  GatewayGuardError,
  GatewayRequestError,
  InvalidSignatureError,
  NoGatewayAvailableError,
  RetryNotAllowedError,
  TimeoutError,
  ValidationError,
} from "../src/errors.js";

describe("errors", () => {
  const cases: Array<[string, Error, string]> = [
    ["ValidationError", new ValidationError("bad"), "VALIDATION"],
    ["InvalidSignatureError", new InvalidSignatureError("razorpay"), "INVALID_SIGNATURE"],
    ["RetryNotAllowedError", new RetryNotAllowedError("paid"), "RETRY_NOT_ALLOWED"],
    ["NoGatewayAvailableError", new NoGatewayAvailableError("upi"), "NO_GATEWAY"],
    [
      "GatewayRequestError",
      new GatewayRequestError("cashfree", 500, "gateway", "boom"),
      "GATEWAY_REQUEST",
    ],
    ["TimeoutError", new TimeoutError("razorpay", null), "TIMEOUT"],
  ];

  it.each(cases)("%s is a GatewayGuardError with stable code", (name, err, code) => {
    expect(err).toBeInstanceOf(GatewayGuardError);
    expect(err).toBeInstanceOf(Error);
    expect((err as GatewayGuardError).code).toBe(code);
    expect(err.name).toBe(name);
  });

  it("TimeoutError is a GatewayRequestError classified as gateway/timeout", () => {
    const e = new TimeoutError("razorpay", null);
    expect(e).toBeInstanceOf(GatewayRequestError);
    expect(e.classification).toBe("gateway");
    expect(e.reason).toBe("timeout");
    expect(e.httpStatus).toBeNull();
  });

  it("carries context fields", () => {
    expect(new InvalidSignatureError("cashfree").gateway).toBe("cashfree");
    expect(new RetryNotAllowedError("pending").reason).toBe("pending");
    expect(new NoGatewayAvailableError("card").method).toBe("card");
    const g = new GatewayRequestError("razorpay", 400, "customer", "bad card");
    expect([g.gateway, g.httpStatus, g.classification, g.reason]).toEqual([
      "razorpay",
      400,
      "customer",
      "bad card",
    ]);
  });
});
