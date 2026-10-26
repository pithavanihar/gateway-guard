import type { Classification } from "../../types.js";

/**
 * How Razorpay payment failures count against gateway health.
 *
 * Reasons come from Razorpay's error list:
 *   https://razorpay.com/docs/errors/payments/list/
 * Sources come from the per-method error parameters:
 *   https://razorpay.com/docs/errors/payments/payment-methods-error-parameters/
 *
 * - `customer`: the customer caused it (cancelled, wrong OTP, no funds, card blocked...).
 *   Never counts against the gateway, and switching gateways would not help.
 * - `gateway`: a technical failure on the gateway, bank or network side. Counts fully.
 * - `unknown`: merchant/integration problems or ambiguous causes. Counts partially.
 *
 * Reasons not listed here (for example the generic `payment_failed`) fall back to the
 * error `source`, then to the error `code`, then to `unknown`.
 */
export interface RazorpayReasonRule {
  reason: string;
  classification: Classification;
  description: string;
}

export const RAZORPAY_REASON_CLASSIFICATION: readonly RazorpayReasonRule[] = [
  // Customer: abandoned or did not complete
  {
    reason: "payment_cancelled",
    classification: "customer",
    description: "Customer cancelled the payment",
  },
  {
    reason: "payment_timed_out",
    classification: "customer",
    description: "Customer did not complete the payment in time",
  },
  {
    reason: "payment_session_expired",
    classification: "customer",
    description: "Payment session expired before completion",
  },
  {
    reason: "payment_collect_request_expired",
    classification: "customer",
    description: "Customer did not approve the UPI collect request",
  },
  {
    reason: "collect_request_pending",
    classification: "customer",
    description: "A collect request is already awaiting the customer",
  },
  {
    reason: "authentication_failed",
    classification: "customer",
    description: "3DS/OTP authentication failed or was abandoned",
  },
  // Customer: wrong details entered
  { reason: "incorrect_otp", classification: "customer", description: "Wrong OTP entered" },
  { reason: "otp_expired", classification: "customer", description: "OTP expired" },
  {
    reason: "otp_attempts_exceeded",
    classification: "customer",
    description: "Too many OTP attempts",
  },
  { reason: "incorrect_pin", classification: "customer", description: "Wrong PIN entered" },
  { reason: "incorrect_atm_pin", classification: "customer", description: "Wrong ATM PIN entered" },
  {
    reason: "pin_attempts_exceeded",
    classification: "customer",
    description: "Too many PIN attempts",
  },
  {
    reason: "pin_not_set",
    classification: "customer",
    description: "No PIN set for the payment method",
  },
  { reason: "incorrect_cvv", classification: "customer", description: "Wrong CVV entered" },
  {
    reason: "incorrect_card_details",
    classification: "customer",
    description: "Wrong card details entered",
  },
  {
    reason: "incorrect_card_expiry_date",
    classification: "customer",
    description: "Wrong card expiry date entered",
  },
  {
    reason: "incorrect_cardholder_name",
    classification: "customer",
    description: "Wrong cardholder name entered",
  },
  {
    reason: "card_number_invalid",
    classification: "customer",
    description: "Card number is invalid",
  },
  { reason: "invalid_vpa", classification: "customer", description: "Wrong UPI VPA entered" },
  // Customer: account or instrument cannot pay
  {
    reason: "insufficient_funds",
    classification: "customer",
    description: "Not enough funds in the account",
  },
  {
    reason: "card_declined",
    classification: "customer",
    description: "Card declined by the issuer",
  },
  { reason: "card_expired", classification: "customer", description: "Card has expired" },
  {
    reason: "card_not_enrolled",
    classification: "customer",
    description: "Card not enrolled for this payment method",
  },
  { reason: "debit_declined", classification: "customer", description: "Debit declined" },
  {
    reason: "debit_instrument_blocked",
    classification: "customer",
    description: "Card or account blocked by issuer or holder",
  },
  {
    reason: "debit_instrument_inactive",
    classification: "customer",
    description: "Card or account inactive",
  },
  {
    reason: "international_transaction_not_allowed",
    classification: "customer",
    description: "Card not enabled for international use",
  },
  {
    reason: "transaction_limit_exceeded",
    classification: "customer",
    description: "Card credit/debit limit exceeded",
  },
  {
    reason: "transaction_daily_limit_exceeded",
    classification: "customer",
    description: "Daily transaction limit reached",
  },
  {
    reason: "transaction_daily_count_exceeded",
    classification: "customer",
    description: "Daily transaction count reached",
  },
  {
    reason: "transaction_frequency_limit_exceeded",
    classification: "customer",
    description: "NPCI frequency limit reached",
  },
  {
    reason: "transaction_on_vpa_restricted",
    classification: "customer",
    description: "VPA blocked by the customer's PSP",
  },
  {
    reason: "funds_blocked_by_mandate",
    classification: "customer",
    description: "Funds held by an existing mandate",
  },
  {
    reason: "authorisation_declined_by_psp",
    classification: "customer",
    description: "Customer's UPI app rejected the request",
  },
  {
    reason: "user_not_eligible",
    classification: "customer",
    description: "Customer not eligible for credit",
  },
  {
    reason: "user_not_registered_for_netbanking",
    classification: "customer",
    description: "Account not registered for netbanking",
  },
  {
    reason: "credit_limit_exceeded",
    classification: "customer",
    description: "Customer's credit limit exceeded",
  },
  {
    reason: "credit_limit_expired",
    classification: "customer",
    description: "Customer's credit limit expired",
  },
  {
    reason: "credit_limit_inactive",
    classification: "customer",
    description: "Customer's credit limit inactive",
  },
  {
    reason: "credit_limit_not_approved",
    classification: "customer",
    description: "Customer's credit limit not approved",
  },
  // Gateway: technical failures on the provider, bank or network side
  {
    reason: "bank_technical_error",
    classification: "gateway",
    description: "Technical error at the bank",
  },
  {
    reason: "gateway_technical_error",
    classification: "gateway",
    description: "Technical error at the gateway",
  },
  { reason: "server_error", classification: "gateway", description: "Internal error at Razorpay" },
  {
    reason: "issuer_technical_error",
    classification: "gateway",
    description: "Technical error at the card issuer",
  },
  {
    reason: "invalid_response_from_gateway",
    classification: "gateway",
    description: "Gateway returned an invalid response",
  },
  { reason: "bank_not_available", classification: "gateway", description: "Bank is down" },
  {
    reason: "bank_cutoff_in_progress",
    classification: "gateway",
    description: "Bank's periodic cutoff in progress",
  },
  {
    reason: "payment_declined_due_to_high_traffic",
    classification: "gateway",
    description: "Gateway overloaded",
  },
  {
    reason: "request_timed_out",
    classification: "gateway",
    description: "Request to the gateway timed out",
  },
  // Unknown: merchant integration/config problems, or ambiguous
  {
    reason: "input_validation_failed",
    classification: "unknown",
    description: "Request failed validation",
  },
  { reason: "invalid_request", classification: "unknown", description: "Malformed request" },
  {
    reason: "payment_method_not_enabled",
    classification: "unknown",
    description: "Method not enabled for the merchant",
  },
  {
    reason: "bank_not_enabled",
    classification: "unknown",
    description: "Bank not enabled for the merchant",
  },
  {
    reason: "card_network_not_enabled",
    classification: "unknown",
    description: "Card network not enabled for the merchant",
  },
  {
    reason: "merchant_not_activated",
    classification: "unknown",
    description: "Merchant account not activated",
  },
  {
    reason: "live_mode_not_enabled",
    classification: "unknown",
    description: "Live mode not enabled",
  },
  {
    reason: "order_amount_mismatch",
    classification: "unknown",
    description: "Order and payment amounts differ",
  },
  {
    reason: "order_payment_method_mismatch",
    classification: "unknown",
    description: "Order and payment methods differ",
  },
  {
    reason: "order_already_paid",
    classification: "unknown",
    description: "Order already has a successful payment",
  },
  {
    reason: "payment_risk_check_failed",
    classification: "unknown",
    description: "Declined by a risk check",
  },
];

export interface RazorpaySourceRule {
  source: string;
  classification: Classification;
}

/** Fallback by `error_source` when the reason is not in the table. Anything else → unknown. */
export const RAZORPAY_SOURCE_CLASSIFICATION: readonly RazorpaySourceRule[] = [
  { source: "customer", classification: "customer" },
  { source: "bank", classification: "gateway" },
  { source: "issuer_bank", classification: "gateway" },
  { source: "issuer", classification: "gateway" },
  { source: "beneficiary_bank", classification: "gateway" },
  { source: "gateway", classification: "gateway" },
  { source: "network", classification: "gateway" },
  { source: "internal", classification: "gateway" },
  { source: "razorpay", classification: "gateway" },
];

/** Last-resort fallback by top-level error `code`. */
export const RAZORPAY_CODE_CLASSIFICATION: readonly {
  code: string;
  classification: Classification;
}[] = [
  { code: "SERVER_ERROR", classification: "gateway" },
  { code: "GATEWAY_ERROR", classification: "gateway" },
];

const byReason = new Map(RAZORPAY_REASON_CLASSIFICATION.map((r) => [r.reason, r.classification]));
const bySource = new Map(RAZORPAY_SOURCE_CLASSIFICATION.map((r) => [r.source, r.classification]));
const byCode = new Map(RAZORPAY_CODE_CLASSIFICATION.map((r) => [r.code, r.classification]));

export function classifyRazorpay(error: {
  source?: string;
  reason?: string;
  code?: string;
}): Classification {
  return (
    (error.reason !== undefined ? byReason.get(error.reason) : undefined) ??
    (error.source !== undefined ? bySource.get(error.source) : undefined) ??
    (error.code !== undefined ? byCode.get(error.code) : undefined) ??
    "unknown"
  );
}
