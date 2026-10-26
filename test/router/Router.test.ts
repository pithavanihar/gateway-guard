import { describe, expect, it } from "vitest";
import { NoGatewayAvailableError } from "../../src/errors.js";
import { HealthTracker } from "../../src/health/HealthTracker.js";
import { Router } from "../../src/router/Router.js";
import type { GatewayName, PaymentMethod } from "../../src/types.js";

const fail = { ok: false, classification: "gateway" } as const;
const ok = { ok: true } as const;

function setup(supports: (g: GatewayName, m: PaymentMethod) => boolean = () => true) {
  const tracker = new HealthTracker({}, { now: () => 0, random: () => 0.9 });
  const router = new Router(tracker, ["razorpay", "cashfree"], supports);
  return { tracker, router };
}

function openIt(t: HealthTracker, g: GatewayName, m: PaymentMethod, oks = 2) {
  for (let i = 0; i < oks; i++) t.record(g, m, ok);
  for (let i = 0; i < 5 - oks; i++) t.record(g, m, fail);
}

describe("Router", () => {
  it("prefers priority order when all healthy", () => {
    const { router } = setup();
    expect(router.choose("upi")).toEqual({ gateway: "razorpay", reason: "preferred" });
  });

  it("fails over when the preferred pair is down", () => {
    const { router, tracker } = setup();
    openIt(tracker, "razorpay", "netbanking");
    expect(router.choose("netbanking")).toEqual({ gateway: "cashfree", reason: "failover" });
    expect(router.choose("upi").gateway).toBe("razorpay");
  });

  it("retry avoids the failed gateway even when healthy", () => {
    const { router } = setup();
    expect(router.choose("upi", { avoid: "razorpay" })).toEqual({
      gateway: "cashfree",
      reason: "retry",
    });
  });

  it("retry falls back to the original when no alternative is usable", () => {
    const { router, tracker } = setup();
    openIt(tracker, "cashfree", "upi");
    expect(router.choose("upi", { avoid: "razorpay" })).toEqual({
      gateway: "razorpay",
      reason: "preferred",
    });
    expect(router.candidates("upi", { avoid: "razorpay" })).toEqual(["razorpay", "cashfree"]);
  });

  it("all down picks lowest failure rate", () => {
    const { router, tracker } = setup();
    openIt(tracker, "razorpay", "upi", 0);
    openIt(tracker, "cashfree", "upi", 1);
    expect(router.choose("upi")).toEqual({ gateway: "cashfree", reason: "all-down" });
    expect(router.candidates("upi")).toEqual(["cashfree", "razorpay"]);
  });

  it("retry when every gateway is down reports all-down", () => {
    const { router, tracker } = setup();
    openIt(tracker, "razorpay", "upi", 0);
    openIt(tracker, "cashfree", "upi", 1);
    expect(router.choose("upi", { avoid: "razorpay" })).toEqual({
      gateway: "cashfree",
      reason: "all-down",
    });
  });

  it("plan returns the candidate order and the reason in one ranking", () => {
    const { router, tracker } = setup();
    openIt(tracker, "razorpay", "netbanking");
    expect(router.plan("netbanking")).toEqual({
      order: ["cashfree", "razorpay"],
      reason: "failover",
      preferred: "razorpay",
    });
  });

  it("candidates honours exclude and ordering", () => {
    const { router } = setup();
    expect(router.candidates("upi", { exclude: ["razorpay"] })).toEqual(["cashfree"]);
    expect(router.candidates("upi")).toEqual(["razorpay", "cashfree"]);
  });

  it("no gateway supports the method", () => {
    const { router } = setup((_g, m) => m !== "card");
    expect(() => router.choose("card")).toThrow(NoGatewayAvailableError);
    expect(() => router.candidates("card")).toThrow(NoGatewayAvailableError);
  });
});
