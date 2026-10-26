import type { Attempt } from "./attempts/AttemptRegistry.js";
import type { WebhookEvent } from "./adapters/Adapter.js";
import type { HealthLabel, PairHealth } from "./health/HealthTracker.js";
import type { RouteReason } from "./router/Router.js";
import type { Classification, GatewayName, PaymentMethod } from "./types.js";

export type GuardEvent =
  | { type: "attempt.created"; attempt: Attempt; reason: RouteReason }
  | { type: "attempt.succeeded"; attempt: Attempt }
  | {
      type: "attempt.failed";
      attempt: Attempt;
      classification: Classification;
      reason?: string;
      countedForHealth: boolean;
    }
  | { type: "health.changed"; health: PairHealth; previous: HealthLabel }
  | {
      type: "route.failover";
      method: PaymentMethod;
      from: GatewayName;
      to: GatewayName;
      why: "unhealthy" | "create-error" | "retry";
    }
  | { type: "webhook.unmatched"; event: WebhookEvent }
  /**
   * More than one attempt of the same `orderId` was confirmed paid: the customer was
   * charged more than once and the consumer should refund the extra payments.
   */
  | { type: "order.multiple-payments"; orderId: string; attempts: Attempt[] };

export type GuardEventType = GuardEvent["type"];
export type GuardEventOf<T extends GuardEventType> = Extract<GuardEvent, { type: T }>;
export type ListenerErrorHandler = (error: unknown, event: GuardEvent) => void;

/**
 * Default handler for a listener that throws: surfaces it as a process warning
 * (non-fatal, visible on stderr) instead of swallowing it or breaking the payment flow.
 */
export const warnListenerError: ListenerErrorHandler = (error, event) => {
  const message = error instanceof Error ? error.message : String(error);
  globalThis.process?.emitWarning?.(
    `gateway-guard: a "${event.type}" listener threw: ${message}`,
    "GatewayGuardListenerWarning",
  );
};

/**
 * Small typed emitter. Each listener runs in its own try/catch: a throwing listener never
 * interrupts the caller or the remaining listeners. Its error goes to `onError`.
 */
export class GuardEmitter {
  private readonly listeners = new Map<GuardEventType, Set<(e: GuardEvent) => void>>();

  constructor(private readonly onError: ListenerErrorHandler = warnListenerError) {}

  on<T extends GuardEventType>(type: T, listener: (event: GuardEventOf<T>) => void): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    // Wrap so the same function can be registered twice and removed independently.
    const wrapped = (e: GuardEvent): void => listener(e as GuardEventOf<T>);
    set.add(wrapped);
    return () => {
      set.delete(wrapped);
    };
  }

  emit(event: GuardEvent): void {
    const set = this.listeners.get(event.type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch (error) {
        try {
          this.onError(error, event);
        } catch {
          // The error handler itself failed; nothing safe is left to report to.
        }
      }
    }
  }
}
