import type { Classification, GatewayName, PaymentMethod } from "../types.js";

export interface HealthOptions {
  windowSize: number;
  windowMs: number;
  minAttempts: number;
  failureThreshold: number;
  degradedThreshold: number;
  cooldownMs: number;
  probeRatio: number;
  unknownWeight: number;
}

export type CircuitState = "closed" | "open" | "half-open";
export type HealthLabel = "healthy" | "degraded" | "down";

export interface PairHealth {
  gateway: GatewayName;
  method: PaymentMethod;
  state: CircuitState;
  label: HealthLabel;
  failureRate: number;
  countedAttempts: number;
  openedAt?: number;
}

type RecordedOutcome = { ok: true } | { ok: false; classification: Classification };

const DEFAULTS: HealthOptions = {
  windowSize: 20,
  windowMs: 300_000,
  minAttempts: 5,
  failureThreshold: 0.5,
  degradedThreshold: 0.25,
  cooldownMs: 60_000,
  probeRatio: 0.2,
  unknownWeight: 0.5,
};

interface Entry {
  at: number;
  weight: number;
  failed: boolean;
}

interface Pair {
  gateway: GatewayName;
  method: PaymentMethod;
  state: CircuitState;
  openedAt?: number;
  entries: Entry[];
  label: HealthLabel;
}

export class HealthTracker {
  private readonly opts: HealthOptions;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly pairs = new Map<string, Pair>();
  private readonly listeners: Array<(h: PairHealth, prev: HealthLabel) => void> = [];

  constructor(
    opts: Partial<HealthOptions> = {},
    deps: { now?: () => number; random?: () => number } = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
    this.now = deps.now ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  record(gateway: GatewayName, method: PaymentMethod, outcome: RecordedOutcome): void {
    if (!outcome.ok && outcome.classification === "customer") return;
    const pair = this.pair(gateway, method);
    this.advance(pair);
    const now = this.now();

    if (pair.state === "open") {
      // Outcomes while open (not routed by us) carry no information.
    } else if (pair.state === "half-open") {
      if (outcome.ok) {
        pair.entries = [];
        pair.state = "closed";
        pair.openedAt = undefined;
      } else {
        pair.state = "open";
        pair.openedAt = now;
      }
    } else {
      const weight = outcome.ok
        ? 1
        : outcome.classification === "unknown"
          ? this.opts.unknownWeight
          : 1;
      pair.entries.push({ at: now, weight, failed: !outcome.ok });
      this.prune(pair);
      const { failureRate, counted } = this.stats(pair);
      if (counted >= this.opts.minAttempts && failureRate >= this.opts.failureThreshold) {
        pair.state = "open";
        pair.openedAt = now;
      }
    }
    this.sync(pair);
  }

  isUsable(gateway: GatewayName, method: PaymentMethod): boolean {
    const pair = this.pair(gateway, method);
    this.advance(pair);
    this.sync(pair);
    if (pair.state === "closed") return true;
    if (pair.state === "open") return false;
    return this.random() < this.opts.probeRatio;
  }

  get(gateway: GatewayName, method: PaymentMethod): PairHealth {
    const pair = this.pair(gateway, method);
    this.advance(pair);
    this.sync(pair);
    return this.view(pair);
  }

  snapshot(): PairHealth[] {
    return [...this.pairs.values()].map((p) => this.get(p.gateway, p.method));
  }

  onChange(cb: (h: PairHealth, prev: HealthLabel) => void): void {
    this.listeners.push(cb);
  }

  private pair(gateway: GatewayName, method: PaymentMethod): Pair {
    const key = `${gateway}:${method}`;
    let p = this.pairs.get(key);
    if (!p) {
      p = { gateway, method, state: "closed", entries: [], label: "healthy" };
      this.pairs.set(key, p);
    }
    return p;
  }

  /** Lazy time-based transitions: open -> half-open, and window pruning. */
  private advance(pair: Pair): void {
    if (
      pair.state === "open" &&
      pair.openedAt !== undefined &&
      this.now() - pair.openedAt >= this.opts.cooldownMs
    ) {
      pair.state = "half-open";
    }
    this.prune(pair);
  }

  private prune(pair: Pair): void {
    const now = this.now();
    let e = pair.entries.filter((x) => now - x.at < this.opts.windowMs);
    if (e.length > this.opts.windowSize) e = e.slice(e.length - this.opts.windowSize);
    pair.entries = e;
  }

  private stats(pair: Pair): { failureRate: number; counted: number } {
    let counted = 0;
    let failed = 0;
    for (const e of pair.entries) {
      counted += e.weight;
      if (e.failed) failed += e.weight;
    }
    return { failureRate: counted === 0 ? 0 : failed / counted, counted };
  }

  private labelOf(pair: Pair): HealthLabel {
    if (pair.state === "open") return "down";
    if (pair.state === "half-open") return "degraded";
    return this.stats(pair).failureRate >= this.opts.degradedThreshold ? "degraded" : "healthy";
  }

  private view(pair: Pair): PairHealth {
    const { failureRate, counted } = this.stats(pair);
    const h: PairHealth = {
      gateway: pair.gateway,
      method: pair.method,
      state: pair.state,
      label: this.labelOf(pair),
      failureRate,
      countedAttempts: counted,
    };
    if (pair.openedAt !== undefined) h.openedAt = pair.openedAt;
    return h;
  }

  private sync(pair: Pair): void {
    const label = this.labelOf(pair);
    if (label === pair.label) return;
    const prev = pair.label;
    pair.label = label;
    const view = this.view(pair);
    for (const cb of this.listeners) cb(view, prev);
  }
}
