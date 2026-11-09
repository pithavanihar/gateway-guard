import type { GatewayAdapter, StatusResult, WebhookEvent } from "./adapters/Adapter.js";
import { CashfreeAdapter, type CashfreeConfig } from "./adapters/cashfree/CashfreeAdapter.js";
import { RazorpayAdapter, type RazorpayConfig } from "./adapters/razorpay/RazorpayAdapter.js";
import { type Attempt, AttemptRegistry, newAttemptId } from "./attempts/AttemptRegistry.js";
import { GatewayRequestError, RetryNotAllowedError, ValidationError } from "./errors.js";
import {
  GuardEmitter,
  type GuardEvent,
  type GuardEventOf,
  type GuardEventType,
  type ListenerErrorHandler,
} from "./events.js";
import { type HealthOptions, type PairHealth, HealthTracker } from "./health/HealthTracker.js";
import { type RouteReason, Router } from "./router/Router.js";
import type {
  Checkout,
  Classification,
  Customer,
  GatewayName,
  Outcome,
  PaymentMethod,
} from "./types.js";
import { validatePaymentInput } from "./validate.js";

export type { GuardEvent, GuardEventOf, GuardEventType, ListenerErrorHandler } from "./events.js";

export interface GatewayGuardOptions {
  gateways: { razorpay?: RazorpayConfig; cashfree?: CashfreeConfig };
  priority: GatewayName[];
  health?: Partial<HealthOptions>;
  /** Per-request timeout for the built-in adapters. Default 15 000 ms. */
  timeoutMs?: number;
  /** Test/demo injection; an adapter here overrides the built-in one of the same name. */
  adapters?: GatewayAdapter[];
  now?: () => number;
  random?: () => number;
  fetch?: typeof fetch;
  /**
   * Called when an event listener throws. The payment flow and the other listeners carry
   * on regardless. Default: emit a process warning (`GatewayGuardListenerWarning`).
   */
  onListenerError?: ListenerErrorHandler;
}

export interface CreatePaymentInput {
  orderId: string;
  amountMinor: number;
  currency: "INR";
  method: PaymentMethod;
  customer: Customer;
  /** attemptId of a failed attempt of the same order that this payment retries. */
  retryOf?: string;
}

export interface CreatePaymentResult {
  attemptId: string;
  gateway: GatewayName;
  checkout: Checkout;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class GatewayGuard {
  private readonly adapters = new Map<GatewayName, GatewayAdapter>();
  private readonly tracker: HealthTracker;
  private readonly router: Router;
  private readonly registry: AttemptRegistry;
  private readonly emitter: GuardEmitter;
  private readonly now: () => number;
  /** Confirmed-paid attempts per orderId, to detect a customer charged twice. */
  private readonly paidByOrder = new Map<string, Map<string, Attempt>>();
  /** The most recent attempt per orderId: the only one that may be retried. */
  private readonly latestByOrder = new Map<string, string>();
  /** orderIds with a createPayment in progress. */
  private readonly inFlight = new Set<string>();

  constructor(opts: GatewayGuardOptions) {
    const now = opts.now ?? Date.now;
    const fetchFn: typeof fetch = opts.fetch ?? ((...args) => globalThis.fetch(...args));
    const deps = { fetch: fetchFn, timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS };
    if (opts.gateways.razorpay) {
      this.adapters.set("razorpay", new RazorpayAdapter(opts.gateways.razorpay, deps));
    }
    if (opts.gateways.cashfree) {
      this.adapters.set("cashfree", new CashfreeAdapter(opts.gateways.cashfree, deps));
    }
    for (const adapter of opts.adapters ?? []) this.adapters.set(adapter.name, adapter);

    this.emitter = new GuardEmitter(opts.onListenerError);
    const healthDeps: { now: () => number; random?: () => number } = { now };
    if (opts.random) healthDeps.random = opts.random;
    this.tracker = new HealthTracker(opts.health ?? {}, healthDeps);
    this.tracker.onChange((health, previous) =>
      this.emitter.emit({ type: "health.changed", health, previous }),
    );
    this.router = new Router(
      this.tracker,
      opts.priority,
      (g, m) => this.adapters.get(g)?.supports(m) ?? false,
    );
    this.registry = new AttemptRegistry({ now });
    this.now = now;
  }

  on<T extends GuardEventType>(type: T, listener: (event: GuardEventOf<T>) => void): () => void {
    return this.emitter.on(type, listener);
  }

  health(): PairHealth[] {
    return this.tracker.snapshot();
  }

  /**
   * Creates a payment attempt. At most one payable order per orderId: a later payment for
   * the same order must pass `retryOf` = the order's latest attempt (otherwise
   * `RetryNotAllowedError("superseded")`), and only one call per orderId runs at a time
   * (otherwise `"in-progress"`).
   */
  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    validatePaymentInput(input);
    // Taken synchronously, before any await, so concurrent calls cannot both pass the checks.
    if (this.inFlight.has(input.orderId)) throw new RetryNotAllowedError("in-progress");
    this.inFlight.add(input.orderId);
    try {
      return await this.create(input);
    } finally {
      this.inFlight.delete(input.orderId);
    }
  }

  private async create(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const { orderId, amountMinor, currency, method, customer } = input;
    this.pruneLatest();
    const latest = this.latestAttempt(orderId);

    let avoid: GatewayName | undefined;
    if (input.retryOf === undefined) {
      if (latest) throw new RetryNotAllowedError("superseded");
    } else {
      avoid = await this.checkRetry(input.retryOf, orderId, latest);
      // A paid confirmation may have arrived while the checks above were awaiting.
      if (this.paidByOrder.has(orderId)) throw new RetryNotAllowedError("paid");
    }

    // One ranking per payment; creation-time failover walks this list.
    const plan = this.router.plan(method, avoid === undefined ? {} : { avoid });
    const first = plan.order[0] as GatewayName;
    if (plan.reason === "retry" && avoid !== undefined) {
      this.emit({ type: "route.failover", method, from: avoid, to: first, why: "retry" });
    } else if (plan.reason === "failover") {
      this.emit({
        type: "route.failover",
        method,
        from: plan.preferred,
        to: first,
        why: "unhealthy",
      });
    } else if (plan.reason === "all-down") {
      this.emit({ type: "route.all-down", method, chosen: first });
    }

    let lastError: unknown;
    for (let i = 0; i < plan.order.length; i++) {
      const gateway = plan.order[i] as GatewayName;
      const adapter = this.adapter(gateway);
      // A fresh id per gateway order: an attemptId is never reused.
      const attemptId = newAttemptId();
      let created: { gatewayRef: string; checkout: Checkout };
      try {
        created = await adapter.createOrder({
          attemptId,
          orderId,
          amountMinor,
          currency,
          method,
          customer,
        });
      } catch (err) {
        // ValidationError and anything unexpected propagate: no health record, no failover.
        if (!(err instanceof GatewayRequestError)) throw err;
        this.tracker.record(gateway, method, { ok: false, classification: err.classification });
        lastError = err;
        const next = plan.order[i + 1];
        if (next !== undefined) {
          this.emit({
            type: "route.failover",
            method,
            from: gateway,
            to: next,
            why: "create-error",
          });
        }
        continue;
      }

      const attempt: Attempt = {
        attemptId,
        orderId,
        gateway,
        method,
        gatewayRef: created.gatewayRef,
        amountMinor,
        createdAt: this.now(),
        checkout: created.checkout,
      };
      this.registry.add(attempt);
      this.latestByOrder.set(orderId, attemptId);
      const reason: RouteReason =
        i === 0 ? plan.reason : plan.reason === "all-down" ? "all-down" : "failover";
      this.emit({ type: "attempt.created", attempt: snapshot(attempt), reason });
      return { attemptId, gateway, checkout: created.checkout };
    }
    throw lastError;
  }

  /**
   * Returns the checkout of an attempt again, so a checkout the customer closed without
   * paying can be reopened instead of retried. No gateway call is made.
   *
   * Throws `RetryNotAllowedError`:
   * - `unknown-attempt`: the id is unknown or has expired (expired attempts are forgotten);
   * - `paid`: the attempt, or another attempt of its order, is confirmed paid;
   * - `in-progress`: a `createPayment` for the order is running;
   * - `superseded`: the attempt was retried, its gateway order was cancelled, or it has
   *   already failed (retry it with `retryOf` instead).
   */
  resume(attemptId: string): CreatePaymentResult {
    const attempt = this.registry.get(attemptId);
    if (!attempt || !attempt.checkout) throw new RetryNotAllowedError("unknown-attempt");
    if (attempt.final === "paid" || this.paidByOrder.has(attempt.orderId)) {
      throw new RetryNotAllowedError("paid");
    }
    if (this.inFlight.has(attempt.orderId)) throw new RetryNotAllowedError("in-progress");
    if (
      this.latestAttempt(attempt.orderId)?.attemptId !== attemptId ||
      attempt.final === "failed" ||
      attempt.cancelled
    ) {
      throw new RetryNotAllowedError("superseded");
    }
    return { attemptId, gateway: attempt.gateway, checkout: attempt.checkout };
  }

  async verifyPayment(attemptId: string, callbackPayload: unknown): Promise<Outcome> {
    const attempt = this.registry.get(attemptId);
    if (!attempt) throw new ValidationError("Unknown attemptId");
    const outcome = await this.adapter(attempt.gateway).verifyCallback(
      attempt.gatewayRef,
      callbackPayload,
    );
    this.settle(attempt, outcome.status, outcome.classification, outcome.reason);
    return outcome;
  }

  verifyWebhook(
    gateway: GatewayName,
    rawBody: string | Uint8Array,
    headers: Record<string, string | string[] | undefined>,
  ): WebhookEvent {
    const event = this.adapter(gateway).verifyWebhook(rawBody, headers);
    const attempt = this.registry.findByGatewayRef(gateway, event.gatewayRef);
    if (!attempt) {
      this.emit({ type: "webhook.unmatched", event });
      return event;
    }
    if (event.status !== "other") {
      this.settle(attempt, event.status, event.classification, event.reason);
    }
    return event;
  }

  /** Returns the gateway to avoid, or throws if retrying could charge the customer twice. */
  private async checkRetry(
    retryOf: string,
    orderId: string,
    latest: Attempt | undefined,
  ): Promise<GatewayName> {
    const prev = this.registry.get(retryOf);
    if (!prev) throw new RetryNotAllowedError("unknown-attempt");
    if (prev.orderId !== orderId) {
      throw new ValidationError("retryOf must refer to an attempt of the same orderId");
    }
    // Only the latest attempt may be retried: an older one already has a live successor.
    if (latest?.attemptId !== prev.attemptId) throw new RetryNotAllowedError("superseded");
    if (this.paidByOrder.has(orderId)) throw new RetryNotAllowedError("paid");

    const adapter = this.adapter(prev.gateway);
    refuseUnlessRetryable(await this.lookup(adapter, prev));

    // A cancelled order stays cancelled: a retry whose creation failed on every gateway
    // can be retried again without a second cancel.
    if (adapter.cancelOrder && !prev.cancelled) {
      try {
        await adapter.cancelOrder(prev.gatewayRef);
      } catch (err) {
        if (err instanceof GatewayRequestError && err.reason === "order_paid") {
          refuseUnlessRetryable(await this.lookup(adapter, prev));
        }
        // Paid-then-failed is contradictory; any other cancel failure leaves the old order
        // possibly payable. Either way a second order is not safe.
        throw new RetryNotAllowedError("status-unknown");
      }
      prev.cancelled = true;
    }
    return prev.gateway;
  }

  /**
   * Fetches the attempt's status and settles a final one (paid or failed) exactly as a
   * callback or webhook would, so outcomes seen only here still reach health, once.
   * Returns null when the lookup itself failed.
   */
  private async lookup(adapter: GatewayAdapter, attempt: Attempt): Promise<StatusResult | null> {
    let result: StatusResult;
    try {
      result = await adapter.fetchStatus(attempt.gatewayRef);
    } catch {
      return null;
    }
    if (result.status === "paid" || result.status === "failed") {
      this.settle(attempt, result.status, result.classification, result.reason);
    }
    return result;
  }

  /** Applies a final outcome once per attempt: health record + event. */
  private settle(
    attempt: Attempt,
    status: "paid" | "failed" | "pending",
    classification: Classification | undefined,
    reason: string | undefined,
  ): void {
    if (status === "paid") {
      const first =
        this.registry.markFinal(attempt.attemptId, "paid") ||
        this.registry.supersedeWithPaid(attempt.attemptId);
      if (first) {
        this.tracker.record(attempt.gateway, attempt.method, { ok: true });
        this.emit({ type: "attempt.succeeded", attempt: snapshot(attempt) });
      }
      this.notePaid(attempt);
    } else if (status === "failed") {
      if (!this.registry.markFinal(attempt.attemptId, "failed")) return;
      const c = classification ?? "unknown";
      this.tracker.record(attempt.gateway, attempt.method, { ok: false, classification: c });
      const event: GuardEvent = {
        type: "attempt.failed",
        attempt: snapshot(attempt),
        classification: c,
        countedForHealth: c !== "customer",
      };
      if (reason !== undefined) event.reason = reason;
      this.emit(event);
    }
  }

  private notePaid(attempt: Attempt): void {
    this.prunePaid();
    let paid = this.paidByOrder.get(attempt.orderId);
    if (!paid) {
      paid = new Map();
      this.paidByOrder.set(attempt.orderId, paid);
    }
    if (paid.has(attempt.attemptId)) return;
    paid.set(attempt.attemptId, attempt);
    if (paid.size > 1) {
      this.emit({
        type: "order.multiple-payments",
        orderId: attempt.orderId,
        attempts: [...paid.values()].map(snapshot),
      });
    }
  }

  /** Drops orders whose attempts have all expired from the registry. */
  private prunePaid(): void {
    for (const [orderId, paid] of this.paidByOrder) {
      if ([...paid.keys()].every((id) => this.registry.get(id) === undefined)) {
        this.paidByOrder.delete(orderId);
      }
    }
  }

  private latestAttempt(orderId: string): Attempt | undefined {
    const id = this.latestByOrder.get(orderId);
    return id === undefined ? undefined : this.registry.get(id);
  }

  /** Forgets orders whose latest attempt has expired from the registry. */
  private pruneLatest(): void {
    for (const [orderId, id] of this.latestByOrder) {
      if (this.registry.get(id) === undefined) this.latestByOrder.delete(orderId);
    }
  }

  private adapter(gateway: GatewayName): GatewayAdapter {
    const adapter = this.adapters.get(gateway);
    if (!adapter) throw new ValidationError(`Gateway ${gateway} is not configured`);
    return adapter;
  }

  private emit(event: GuardEvent): void {
    this.emitter.emit(event);
  }
}

/** A copy of an attempt for event payloads, without the internal checkout and cancel flag. */
function snapshot(attempt: Attempt): Attempt {
  const { checkout: _checkout, cancelled: _cancelled, ...rest } = attempt;
  return rest;
}

/**
 * A retry may follow an attempt that failed, or one whose checkout was opened and closed
 * without a payment (`created`). Anything else could still charge the customer.
 */
function refuseUnlessRetryable(result: StatusResult | null): void {
  const status = result?.status;
  if (status === "failed" || status === "created") return;
  if (status === "paid") throw new RetryNotAllowedError("paid");
  if (status === "pending") throw new RetryNotAllowedError("pending");
  throw new RetryNotAllowedError("status-unknown");
}
