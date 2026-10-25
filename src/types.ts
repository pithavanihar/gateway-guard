export type GatewayName = "razorpay" | "cashfree" | "phonepe";
export type PaymentMethod = "upi" | "card" | "netbanking";
export type Classification = "customer" | "gateway" | "unknown";
export type AttemptStatus = "created" | "pending" | "paid" | "failed";

export interface Customer {
  id: string;
  phone: string;
  email?: string;
  name?: string;
}

export type Checkout =
  | {
      gateway: "razorpay";
      keyId: string;
      orderId: string;
      amountMinor: number;
      currency: "INR";
      method: PaymentMethod;
    }
  | {
      gateway: "cashfree";
      paymentSessionId: string;
      mode: "sandbox" | "production";
      method: PaymentMethod;
    };

export interface Outcome {
  status: "paid" | "failed" | "pending";
  classification?: Classification;
  reason?: string;
  method?: PaymentMethod;
}
