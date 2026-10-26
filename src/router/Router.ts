import { NoGatewayAvailableError } from "../errors.js";
import type { HealthTracker } from "../health/HealthTracker.js";
import type { GatewayName, PaymentMethod } from "../types.js";

export type RouteReason = "preferred" | "failover" | "retry" | "all-down";

export interface RouteOptions {
  avoid?: GatewayName;
  exclude?: GatewayName[];
}

interface Ranked {
  order: GatewayName[];
  firstSupporting: GatewayName;
  anyUsable: boolean;
}

export class Router {
  constructor(
    private readonly health: HealthTracker,
    private readonly priority: GatewayName[],
    private readonly supports: (g: GatewayName, m: PaymentMethod) => boolean,
  ) {}

  choose(
    method: PaymentMethod,
    opts: RouteOptions = {},
  ): { gateway: GatewayName; reason: RouteReason } {
    const { order, firstSupporting, anyUsable } = this.rank(method, opts);
    const gateway = order[0] as GatewayName;
    let reason: RouteReason;
    if (opts.avoid !== undefined && gateway !== opts.avoid) reason = "retry";
    else if (!anyUsable) reason = "all-down";
    else reason = gateway === firstSupporting ? "preferred" : "failover";
    return { gateway, reason };
  }

  candidates(method: PaymentMethod, opts: RouteOptions = {}): GatewayName[] {
    return this.rank(method, opts).order;
  }

  private rank(method: PaymentMethod, opts: RouteOptions): Ranked {
    const exclude = opts.exclude ?? [];
    const supporting = this.priority.filter((g) => this.supports(g, method));
    const eligible = supporting.filter((g) => !exclude.includes(g));
    const firstSupporting = supporting[0];
    if (eligible.length === 0 || firstSupporting === undefined) {
      throw new NoGatewayAvailableError(method);
    }

    // isUsable consumes a random draw in half-open: call once per gateway.
    const usable = new Map(eligible.map((g) => [g, this.health.isUsable(g, method)]));
    const isUsable = (g: GatewayName): boolean => usable.get(g) === true;

    const order = eligible.filter((g) => g !== opts.avoid && isUsable(g));
    const anyUsable = eligible.some(isUsable);
    if (opts.avoid !== undefined && eligible.includes(opts.avoid) && isUsable(opts.avoid)) {
      order.push(opts.avoid);
    }
    const rest = eligible
      .filter((g) => !isUsable(g))
      .map((g, i) => ({ g, i, rate: this.health.get(g, method).failureRate }))
      .sort((a, b) => a.rate - b.rate || a.i - b.i)
      .map((x) => x.g);
    return { order: [...order, ...rest], firstSupporting, anyUsable };
  }
}
