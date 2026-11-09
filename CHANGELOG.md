# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0]

First release.

### Added

- `GatewayGuard`: `createPayment`, `resume`, `verifyPayment`, `verifyWebhook`, `health()` and typed
  events.
- Razorpay and Cashfree adapters (zero runtime dependencies, built-in `fetch`).
- Failure classification (`customer` / `gateway` / `unknown`) per gateway, from data tables
  exported by the package and documented in the README.
- Health tracking per `(gateway, method)` with a circuit breaker (closed, open, half-open),
  automatic failover and recovery probes.
- Retry routing to a different gateway, with double-charge safeguards: only the latest attempt of
  an order can be retried, the previous attempt's status is checked first (a retry is allowed after
  a failure or a checkout closed without payment, refused while a payment is pending), Cashfree
  orders are terminated before a retry, and `order.multiple-payments` reports an order paid more
  than once. An outcome found by that status check is recorded for health once, like a webhook.
- `resume(attemptId)` returns the stored checkout so a dismissed checkout can be reopened instead
  of retried.
- Constructor validation: `gateways` and `priority` must agree (every configured gateway listed
  exactly once).
- Errors: `ValidationError`, `InvalidSignatureError`, `RetryNotAllowedError`,
  `NoGatewayAvailableError`, `GatewayRequestError` and `TimeoutError`. Invalid input (including an
  amount under Rs 1 and a parsed webhook body) is rejected before any request.
- `fetchJson`, `Router`, `HealthTracker` and `AttemptRegistry` exported for custom adapters and
  advanced use.
- Events: `attempt.created`, `attempt.succeeded`, `attempt.failed`, `health.changed`,
  `route.failover`, `route.all-down`, `webhook.unmatched`, `order.multiple-payments`.
- ESM and CommonJS builds with type declarations; Node.js 18 or newer.
- Examples: an Express server and a browser checkout page.

### Known limits

- State is in memory, per process.
- Razorpay automatic capture is assumed: an `authorized` payment counts as paid.
- Razorpay orders cannot be cancelled, so a late payment on an old order after a retry is
  detected (`order.multiple-payments`), not prevented.
- Live sandbox smoke tests exist (`npm run test:sandbox`) but have not yet been run against real
  Razorpay or Cashfree sandboxes.

[1.0.0]: https://github.com/pithavanihar/gateway-guard/releases/tag/v1.0.0
