import type { Classification, GatewayName, PaymentMethod } from "./types.js";

export class GatewayGuardError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

export class ValidationError extends GatewayGuardError {
  constructor(message: string) {
    super("VALIDATION", message);
  }
}

export class InvalidSignatureError extends GatewayGuardError {
  readonly gateway: GatewayName;

  constructor(gateway: GatewayName) {
    super("INVALID_SIGNATURE", `Invalid signature from ${gateway}`);
    this.gateway = gateway;
  }
}

/**
 * - `superseded`: `retryOf` is not the latest attempt of its order (it was already retried),
 *   or a payment without `retryOf` was requested for an order that already has an attempt.
 * - `in-progress`: another `createPayment` for the same orderId is still running.
 */
export type RetryNotAllowedReason =
  "paid" | "pending" | "status-unknown" | "unknown-attempt" | "superseded" | "in-progress";

export class RetryNotAllowedError extends GatewayGuardError {
  readonly reason: RetryNotAllowedReason;

  constructor(reason: RetryNotAllowedReason) {
    super("RETRY_NOT_ALLOWED", `Retry not allowed: ${reason}`);
    this.reason = reason;
  }
}

export class NoGatewayAvailableError extends GatewayGuardError {
  readonly method: PaymentMethod;

  constructor(method: PaymentMethod) {
    super("NO_GATEWAY", `No healthy gateway available for ${method}`);
    this.method = method;
  }
}

export class GatewayRequestError extends GatewayGuardError {
  readonly gateway: GatewayName;
  readonly httpStatus: number | null;
  readonly classification: Classification;
  readonly reason: string;

  constructor(
    gateway: GatewayName,
    httpStatus: number | null,
    classification: Classification,
    reason: string,
    code = "GATEWAY_REQUEST",
  ) {
    super(code, `${gateway} request failed: ${reason}`);
    this.gateway = gateway;
    this.httpStatus = httpStatus;
    this.classification = classification;
    this.reason = reason;
  }
}

export class TimeoutError extends GatewayRequestError {
  constructor(gateway: GatewayName, httpStatus: number | null = null) {
    super(gateway, httpStatus, "gateway", "timeout", "TIMEOUT");
  }
}
