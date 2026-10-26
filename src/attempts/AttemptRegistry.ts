import { randomUUID } from "node:crypto";
import type { GatewayName, PaymentMethod } from "../types.js";

export interface Attempt {
  attemptId: string;
  orderId: string;
  gateway: GatewayName;
  method: PaymentMethod;
  gatewayRef: string;
  amountMinor: number;
  createdAt: number;
  final?: "paid" | "failed";
}

export function newAttemptId(): string {
  return "att_" + randomUUID();
}

const DEFAULT_TTL_MS = 86_400_000;

export class AttemptRegistry {
  private readonly byId = new Map<string, Attempt>();
  private readonly byRef = new Map<string, string>();
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(deps: { now?: () => number; ttlMs?: number } = {}) {
    this.now = deps.now ?? Date.now;
    this.ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
  }

  add(a: Omit<Attempt, "final">): void {
    this.prune();
    this.byId.set(a.attemptId, { ...a });
    this.byRef.set(refKey(a.gateway, a.gatewayRef), a.attemptId);
  }

  get(attemptId: string): Attempt | undefined {
    const a = this.byId.get(attemptId);
    if (!a || this.expired(a)) return undefined;
    return a;
  }

  findByGatewayRef(gateway: GatewayName, gatewayRef: string): Attempt | undefined {
    const id = this.byRef.get(refKey(gateway, gatewayRef));
    return id === undefined ? undefined : this.get(id);
  }

  /** Returns true only the first time an outcome is recorded for the attempt. */
  markFinal(attemptId: string, status: "paid" | "failed"): boolean {
    const a = this.get(attemptId);
    if (!a || a.final !== undefined) return false;
    a.final = status;
    return true;
  }

  /**
   * Upgrades an attempt already finalised as failed to paid (a gateway can report a
   * success after a failure, e.g. a customer retrying inside the same checkout). Money
   * moved, so it must not be dropped. Returns true only on the upgrade itself.
   */
  supersedeWithPaid(attemptId: string): boolean {
    const a = this.get(attemptId);
    if (!a || a.final !== "failed") return false;
    a.final = "paid";
    return true;
  }

  prune(): void {
    for (const a of [...this.byId.values()]) {
      if (this.expired(a)) {
        this.byId.delete(a.attemptId);
        const key = refKey(a.gateway, a.gatewayRef);
        if (this.byRef.get(key) === a.attemptId) this.byRef.delete(key);
      }
    }
  }

  private expired(a: Attempt): boolean {
    return this.now() - a.createdAt > this.ttlMs;
  }
}

function refKey(gateway: GatewayName, gatewayRef: string): string {
  return `${gateway}:${gatewayRef}`;
}
