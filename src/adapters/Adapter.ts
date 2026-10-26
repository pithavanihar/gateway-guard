import type {
  AttemptStatus,
  Checkout,
  Classification,
  Customer,
  GatewayName,
  Outcome,
  PaymentMethod,
} from "../types.js";

export interface CreateOrderInput {
  attemptId: string;
  orderId: string;
  amountMinor: number;
  currency: "INR";
  method: PaymentMethod;
  customer: Customer;
}

export interface WebhookEvent {
  gateway: GatewayName;
  gatewayRef: string;
  eventId?: string;
  status: "paid" | "failed" | "other";
  method?: PaymentMethod;
  classification?: Classification;
  reason?: string;
  raw: unknown;
}

export interface GatewayAdapter {
  readonly name: GatewayName;
  supports(method: PaymentMethod): boolean;
  createOrder(input: CreateOrderInput): Promise<{ gatewayRef: string; checkout: Checkout }>;
  fetchStatus(gatewayRef: string): Promise<StatusResult>;
  verifyCallback(gatewayRef: string, payload: unknown): Promise<Outcome>;
  verifyWebhook(
    rawBody: string | Uint8Array,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent;
}

/**
 * Result of `fetchStatus`. `Outcome.status` is omitted from the partial so that
 * `"created"` stays representable (intersecting with `Partial<Outcome>` would narrow
 * `status` to `"paid" | "failed" | "pending"`).
 */
export type StatusResult = { status: AttemptStatus } & Partial<Omit<Outcome, "status">>;
