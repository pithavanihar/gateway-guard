import type { Classification } from "../../types.js";

/**
 * How Cashfree payment failures count against gateway health.
 *
 * Payment statuses come from the payment entity (API version 2023-08-01):
 *   https://www.cashfree.com/docs/api-reference/payments/previous/v2023-08-01/payments/get-payments-for-order
 * Reasons and sources come from Cashfree's "Payment Error List", linked from
 *   https://www.cashfree.com/docs/api-reference/payments/errors
 *
 * - `customer`: the customer caused it (dropped, cancelled, wrong PIN/OTP, no funds...).
 *   Never counts against the gateway, and switching gateways would not help.
 * - `gateway`: a technical failure at Cashfree, its acquirer, the bank or the network.
 * - `unknown`: merchant configuration problems or ambiguous causes.
 *
 * Order: a customer status (`USER_DROPPED`, `CANCELLED`) → the reason table → the
 * `error_source` table → `unknown`.
 */
export const CASHFREE_CUSTOMER_STATUSES: readonly string[] = ["USER_DROPPED", "CANCELLED"];

export interface CashfreeReasonRule {
  reason: string;
  classification: Classification;
  description: string;
}

/**
 * Reasons whose every entry in Cashfree's error list has the same kind of source, so the
 * reason alone is enough. Reasons Cashfree reports with conflicting sources are left out
 * (see `CASHFREE_SOURCE_DECIDED_REASONS`).
 */
export const CASHFREE_REASON_CLASSIFICATION: readonly CashfreeReasonRule[] = [
  // Customer: abandoned or cancelled
  {
    reason: "user_dropped",
    classification: "customer",
    description: "Customer abandoned the flow",
  },
  {
    reason: "user_cancelled",
    classification: "customer",
    description: "Customer cancelled the payment",
  },
  {
    reason: "customer_cancelled",
    classification: "customer",
    description: "Customer cancelled the payment",
  },
  {
    reason: "customer_inactive",
    classification: "customer",
    description: "Customer did not attempt the payment",
  },
  {
    reason: "user_decline",
    classification: "customer",
    description: "Customer declined the request",
  },
  {
    reason: "request_expired",
    classification: "customer",
    description: "Customer did not authorise in time",
  },
  {
    reason: "auth_timeout",
    classification: "customer",
    description: "Customer did not authenticate in time",
  },
  {
    reason: "transaction_time_limit",
    classification: "customer",
    description: "Payment session expired",
  },
  // Customer: wrong details entered
  { reason: "invalid_otp", classification: "customer", description: "Wrong OTP entered" },
  { reason: "invalid_pin", classification: "customer", description: "Wrong PIN entered" },
  { reason: "invalid_mpin", classification: "customer", description: "Wrong UPI PIN entered" },
  { reason: "invalid_atmpin", classification: "customer", description: "Wrong ATM PIN entered" },
  { reason: "invalid_cvv", classification: "customer", description: "Wrong CVV entered" },
  { reason: "invalid_card_cvv", classification: "customer", description: "Wrong CVV entered" },
  {
    reason: "invalid_card_number",
    classification: "customer",
    description: "Wrong card number entered",
  },
  {
    reason: "invalid_cardnumber",
    classification: "customer",
    description: "Wrong card number entered",
  },
  {
    reason: "invalid_expiry_date",
    classification: "customer",
    description: "Wrong card expiry date entered",
  },
  {
    reason: "invalid_card_expiry",
    classification: "customer",
    description: "Wrong card expiry date entered",
  },
  {
    reason: "invalid_card_holder_name",
    classification: "customer",
    description: "Wrong cardholder name entered",
  },
  { reason: "invalid_vpa", classification: "customer", description: "Wrong UPI ID entered" },
  { reason: "expired_vpa", classification: "customer", description: "UPI ID has expired" },
  {
    reason: "invalid_account_number",
    classification: "customer",
    description: "Wrong account number entered",
  },
  {
    reason: "pin_try_exceeded",
    classification: "customer",
    description: "Too many PIN attempts",
  },
  {
    reason: "transaction_pin_limit",
    classification: "customer",
    description: "Too many PIN attempts",
  },
  // Customer: account or instrument cannot pay
  {
    reason: "insufficient_funds",
    classification: "customer",
    description: "Not enough funds in the account",
  },
  {
    reason: "auth_declined",
    classification: "customer",
    description: "Issuer or PSP declined the customer's authorisation",
  },
  { reason: "expired_card", classification: "customer", description: "Card has expired" },
  { reason: "card_expired", classification: "customer", description: "Card has expired" },
  { reason: "inactive_card", classification: "customer", description: "Card is inactive" },
  { reason: "restricted_card", classification: "customer", description: "Card is restricted" },
  { reason: "lost_card", classification: "customer", description: "Card reported lost" },
  { reason: "account_blocked", classification: "customer", description: "Account is blocked" },
  { reason: "account_closed", classification: "customer", description: "Account is closed" },
  {
    reason: "inactive_account",
    classification: "customer",
    description: "Account is closed or inactive",
  },
  {
    reason: "credit_limit",
    classification: "customer",
    description: "Card credit limit exceeded",
  },
  {
    reason: "daily_limit_exceed",
    classification: "customer",
    description: "Daily transaction limit reached",
  },
  {
    reason: "daily_amount_limit",
    classification: "customer",
    description: "Daily amount limit reached",
  },
  {
    reason: "transaction_count_limit",
    classification: "customer",
    description: "Transaction count limit reached",
  },
  {
    reason: "transaction_frequency_limit",
    classification: "customer",
    description: "Transaction frequency limit reached",
  },
  {
    reason: "transaction_limit_exceed",
    classification: "customer",
    description: "Per-transaction limit set by the remitter bank exceeded",
  },
  {
    reason: "psp_declined",
    classification: "customer",
    description: "Customer's UPI app declined the payment",
  },
  {
    reason: "psp_unavailable",
    classification: "customer",
    description: "Customer's UPI app is unavailable",
  },
  {
    reason: "merchant_blocked",
    classification: "customer",
    description: "Customer has blocked this merchant",
  },
  // Gateway: technical failures at Cashfree, the bank or the network
  {
    reason: "technical_error",
    classification: "gateway",
    description: "Technical error at the bank or gateway",
  },
  { reason: "general_failure", classification: "gateway", description: "Unspecified bank failure" },
  { reason: "system_error", classification: "gateway", description: "System error at the bank" },
  { reason: "server_error", classification: "gateway", description: "Bank server error" },
  { reason: "network_error", classification: "gateway", description: "Network error" },
  { reason: "network_timeout", classification: "gateway", description: "Network timed out" },
  { reason: "host_timeout", classification: "gateway", description: "Payment processor timed out" },
  { reason: "issuer_timeout", classification: "gateway", description: "Issuer bank timed out" },
  { reason: "bank_offline", classification: "gateway", description: "Bank is offline" },
  {
    reason: "issuer_bank_offline",
    classification: "gateway",
    description: "Issuer bank is offline",
  },
  {
    reason: "acquirer_bank_offline",
    classification: "gateway",
    description: "Acquirer bank is offline",
  },
  {
    reason: "bank_server_downtime",
    classification: "gateway",
    description: "Bank or PSP server down",
  },
  {
    reason: "service_provider_down",
    classification: "gateway",
    description: "Bank's service provider is down",
  },
  {
    reason: "response_awaited",
    classification: "gateway",
    description: "No final response from the bank",
  },
  {
    reason: "transaction_timeout",
    classification: "gateway",
    description: "Gateway processing timed out",
  },
  {
    reason: "bank_decline_throttle",
    classification: "gateway",
    description: "Bank throttled the request",
  },
  { reason: "cutoff_time", classification: "gateway", description: "Bank cutoff in progress" },
  {
    reason: "unknown_network_error",
    classification: "gateway",
    description: "Unspecified network error",
  },
  // Unknown: merchant configuration
  {
    reason: "merchant_transaction_limit",
    classification: "unknown",
    description: "Amount exceeds the merchant's limit",
  },
  {
    reason: "maximum_amount_limit",
    classification: "unknown",
    description: "Amount exceeds the merchant's limit",
  },
  {
    reason: "currency_not_supported",
    classification: "unknown",
    description: "Currency not supported for the merchant",
  },
  {
    reason: "permission_denied",
    classification: "unknown",
    description: "PSP not allowed to initiate this payment",
  },
  {
    reason: "payment_instrument_not_register",
    classification: "unknown",
    description: "Merchant instrument not registered at the bank",
  },
];

export interface CashfreeSourceRule {
  source: string;
  classification: Classification;
}

/** Classification by `error_details.error_source` when the reason is not in the table. */
export const CASHFREE_SOURCE_CLASSIFICATION: readonly CashfreeSourceRule[] = [
  { source: "customer", classification: "customer" },
  { source: "bank", classification: "gateway" },
  { source: "cashfree", classification: "gateway" },
  { source: "gateway", classification: "gateway" },
  { source: "merchant", classification: "unknown" },
];

/**
 * Reasons Cashfree's error list reports with different sources (for example
 * `vpa_resolution_failed` from both `customer` and `bank`). The reason says nothing about
 * fault, so `error_source` decides.
 */
export const CASHFREE_SOURCE_DECIDED_REASONS: readonly { reason: string; description: string }[] = [
  { reason: "auth_failure", description: "Authentication failed (customer or bank)" },
  { reason: "debit_failed", description: "Debit failed (bank or merchant)" },
  { reason: "vpa_resolution_failed", description: "UPI ID could not be resolved" },
  { reason: "transaction_amount_limit", description: "Amount limit exceeded" },
  { reason: "transaction_not_allowed", description: "Transaction not allowed" },
  { reason: "minimum_amount_limit", description: "Amount below the minimum" },
  { reason: "invalid_amount", description: "Invalid amount or currency" },
  { reason: "fraud_detected", description: "Suspected fraud" },
  { reason: "bad_request", description: "Malformed request" },
  { reason: "invalid_account", description: "Invalid account details" },
  { reason: "limit_exceed", description: "Limit exceeded" },
];

const customerStatuses = new Set(CASHFREE_CUSTOMER_STATUSES);
const byReason = new Map(CASHFREE_REASON_CLASSIFICATION.map((r) => [r.reason, r.classification]));
const bySource = new Map(CASHFREE_SOURCE_CLASSIFICATION.map((r) => [r.source, r.classification]));

export function classifyCashfree(p: {
  payment_status: string;
  error_details?: { error_code?: string; error_reason?: string; error_source?: string };
}): Classification {
  if (customerStatuses.has(p.payment_status)) return "customer";
  const reason = p.error_details?.error_reason;
  const source = p.error_details?.error_source;
  return (
    (reason !== undefined ? byReason.get(reason) : undefined) ??
    (source !== undefined ? bySource.get(source) : undefined) ??
    "unknown"
  );
}
