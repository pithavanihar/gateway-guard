import { describe, expect, it } from "vitest";
import { HealthTracker } from "../../src/health/HealthTracker.js";
import type { HealthLabel, PairHealth } from "../../src/health/HealthTracker.js";

const fail = { ok: false, classification: "gateway" } as const;
const unknown = { ok: false, classification: "unknown" } as const;
const customer = { ok: false, classification: "customer" } as const;
const ok = { ok: true } as const;

function setup(random = 0.1) {
  const clock = { t: 0, r: random };
  const tracker = new HealthTracker({}, { now: () => clock.t, random: () => clock.r });
  return { clock, tracker };
}

function openIt(tracker: HealthTracker, g = "razorpay" as const, m = "netbanking" as const) {
  tracker.record(g, m, ok);
  tracker.record(g, m, ok);
  for (let i = 0; i < 3; i++) tracker.record(g, m, fail);
}

describe("HealthTracker", () => {
  it("customer cancellations never open the circuit", () => {
    const { tracker } = setup();
    for (let i = 0; i < 50; i++) tracker.record("razorpay", "upi", customer);
    const h = tracker.get("razorpay", "upi");
    expect(h.state).toBe("closed");
    expect(h.label).toBe("healthy");
  });

  it("opens at 50% gateway failures with at least 5 attempts", () => {
    const { tracker } = setup();
    tracker.record("razorpay", "upi", ok);
    tracker.record("razorpay", "upi", fail);
    tracker.record("razorpay", "upi", fail);
    tracker.record("razorpay", "upi", fail);
    expect(tracker.get("razorpay", "upi").state).toBe("closed");
    tracker.record("cashfree", "upi", ok);
    tracker.record("cashfree", "upi", ok);
    for (let i = 0; i < 3; i++) tracker.record("cashfree", "upi", fail);
    expect(tracker.get("cashfree", "upi").state).toBe("open");
    expect(tracker.get("cashfree", "upi").label).toBe("down");
    expect(tracker.isUsable("cashfree", "upi")).toBe(false);
  });

  it("unknown failures count half", () => {
    const { tracker } = setup();
    for (let i = 0; i < 5; i++) tracker.record("razorpay", "upi", ok);
    for (let i = 0; i < 4; i++) tracker.record("razorpay", "upi", unknown);
    const h = tracker.get("razorpay", "upi");
    expect(h.state).toBe("closed");
    expect(h.label).toBe("degraded");
  });

  it("isolated per method", () => {
    const { tracker } = setup();
    openIt(tracker);
    expect(tracker.get("razorpay", "netbanking").state).toBe("open");
    expect(tracker.isUsable("razorpay", "upi")).toBe(true);
  });

  it("outcomes older than windowMs drop out", () => {
    const { clock, tracker } = setup();
    for (let i = 0; i < 3; i++) tracker.record("razorpay", "upi", fail);
    clock.t += 300_001;
    for (let i = 0; i < 3; i++) tracker.record("razorpay", "upi", ok);
    expect(tracker.get("razorpay", "upi").state).toBe("closed");
  });

  it("half-open after cooldown, probes by probeRatio", () => {
    const { clock, tracker } = setup();
    openIt(tracker);
    expect(tracker.get("razorpay", "netbanking").openedAt).toBe(0);
    clock.t += 59_999;
    expect(tracker.get("razorpay", "netbanking").state).toBe("open");
    clock.t += 1;
    expect(tracker.get("razorpay", "netbanking").state).toBe("half-open");
    expect(tracker.get("razorpay", "netbanking").label).toBe("degraded");
    clock.r = 0.1;
    expect(tracker.isUsable("razorpay", "netbanking")).toBe(true);
    clock.r = 0.5;
    expect(tracker.isUsable("razorpay", "netbanking")).toBe(false);
  });

  it("probe success closes, probe failure reopens", () => {
    const { clock, tracker } = setup();
    openIt(tracker);
    clock.t += 60_000;
    tracker.record("razorpay", "netbanking", ok);
    let h = tracker.get("razorpay", "netbanking");
    expect(h.state).toBe("closed");
    expect(h.countedAttempts).toBe(0);
    expect(h.label).toBe("healthy");

    openIt(tracker);
    clock.t += 60_000;
    expect(tracker.get("razorpay", "netbanking").state).toBe("half-open");
    clock.t += 5;
    tracker.record("razorpay", "netbanking", fail);
    h = tracker.get("razorpay", "netbanking");
    expect(h.state).toBe("open");
    expect(h.openedAt).toBe(clock.t);
  });

  it("onChange fires on label change only", () => {
    const { clock, tracker } = setup();
    const calls: Array<[PairHealth, HealthLabel]> = [];
    tracker.onChange((h, prev) => calls.push([h, prev]));
    for (let i = 0; i < 4; i++) tracker.record("razorpay", "upi", ok);
    expect(calls).toHaveLength(0);
    for (let i = 0; i < 4; i++) tracker.record("razorpay", "upi", fail);
    // 4 ok + 4 fail -> 50% -> open: healthy->degraded (at 20%+) then ->down
    const labels = calls.map(([h]) => h.label);
    expect(labels).toEqual(["degraded", "down"]);
    expect(calls[0]![1]).toBe("healthy");
    expect(calls[1]![1]).toBe("degraded");
    tracker.record("razorpay", "upi", fail); // still down, no event
    expect(calls).toHaveLength(2);
    clock.t += 60_000;
    tracker.get("razorpay", "upi");
    expect(calls.map(([h]) => h.label)).toEqual(["degraded", "down", "degraded"]);
  });
});
