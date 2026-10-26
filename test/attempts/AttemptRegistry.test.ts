import { describe, expect, it } from "vitest";
import { AttemptRegistry, newAttemptId } from "../../src/attempts/AttemptRegistry.js";

const base = {
  attemptId: "att_1",
  orderId: "o1",
  gateway: "razorpay" as const,
  method: "upi" as const,
  gatewayRef: "ref_1",
  amountMinor: 1000,
  createdAt: 0,
};

describe("AttemptRegistry", () => {
  it("markFinal returns true once, then false", () => {
    const r = new AttemptRegistry({ now: () => 0 });
    r.add(base);
    expect(r.markFinal("att_1", "paid")).toBe(true);
    expect(r.markFinal("att_1", "paid")).toBe(false);
    expect(r.markFinal("att_1", "failed")).toBe(false);
    expect(r.get("att_1")?.final).toBe("paid");
    expect(r.markFinal("missing", "paid")).toBe(false);
  });

  it("findByGatewayRef finds the attempt", () => {
    const r = new AttemptRegistry({ now: () => 0 });
    r.add(base);
    expect(r.findByGatewayRef("razorpay", "ref_1")?.attemptId).toBe("att_1");
    expect(r.findByGatewayRef("cashfree", "ref_1")).toBeUndefined();
  });

  it("expired attempts are pruned after ttl", () => {
    let t = 0;
    const r = new AttemptRegistry({ now: () => t, ttlMs: 1000 });
    r.add(base);
    t = 999;
    expect(r.get("att_1")).toBeDefined();
    t = 1001;
    expect(r.get("att_1")).toBeUndefined();
    expect(r.findByGatewayRef("razorpay", "ref_1")).toBeUndefined();
    expect(r.markFinal("att_1", "paid")).toBe(false);
    r.add({ ...base, attemptId: "att_2", gatewayRef: "ref_2", createdAt: 1001 });
    expect(r.get("att_2")).toBeDefined();
  });

  it("newAttemptId is unique and prefixed", () => {
    const a = newAttemptId();
    expect(a.startsWith("att_")).toBe(true);
    expect(newAttemptId()).not.toBe(a);
  });
});
