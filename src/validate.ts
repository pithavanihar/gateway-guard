import { ValidationError } from "./errors.js";
import type { Customer } from "./types.js";

const METHODS = ["upi", "card", "netbanking"];

export function validatePaymentInput(input: {
  orderId: string;
  amountMinor: number;
  currency: string;
  method: string;
  customer: Customer;
}): void {
  if (typeof input.orderId !== "string" || input.orderId.length === 0) {
    throw new ValidationError("orderId is required");
  }
  if (input.orderId.length > 40) {
    throw new ValidationError("orderId must be at most 40 characters");
  }
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new ValidationError("amountMinor must be a positive integer (paise)");
  }
  if (input.currency !== "INR") {
    throw new ValidationError('currency must be "INR"');
  }
  if (!METHODS.includes(input.method)) {
    throw new ValidationError(`method must be one of ${METHODS.join(", ")}`);
  }
  const phone = input.customer?.phone;
  if (typeof phone !== "string" || phone.trim().length === 0) {
    throw new ValidationError("customer.phone is required");
  }
}
