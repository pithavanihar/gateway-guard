# gateway-guard v1: design

**Status:** draft for approval · **Date:** 2026-10-25 · **Owner:** Nihar Pithava

## 1. Intent

gateway-guard is an open-source TypeScript library: one API in front of several Indian payment gateways, which
**sends each payment to a gateway that's working right now** and moves customers off a gateway the moment it
starts failing.

It is Nihar's flagship GitHub project. Its job is to make a visitor (a client or a recruiter) think: *"this
developer understands hard, real-world logic, so I can trust him with my complex project."* Payments are the
domain Nihar knows from production work at Petpooja; the library is built fresh, using no Petpooja code, only the
concept.

### The idea that makes it more than a wrapper (Nihar's own insight)

1. **Not every failure is the gateway's fault.** A customer cancelling, closing the page, or typing a wrong OTP
   says nothing about gateway health and must **never** count against it. Only gateway-side failures count
   (bank/network errors, timeouts, server errors, "bank unavailable").
2. **Health is tracked per gateway *and* payment method.** Razorpay netbanking can be failing while Razorpay UPI
   is fine. The unit of health is the pair `(gateway, method)`.
3. **A retry goes to a different gateway.** When one customer's payment fails on gateway A and they retry, the
   retry is routed to another gateway, even if A still looks healthy overall.

## 2. Goals (v1)

- One API to create payments, verify payments and verify webhooks across gateways.
- **Gateways:** Razorpay + Cashfree in v1. PhonePe in v1.1 once Nihar has sandbox (UAT) credentials. If PhonePe
  credentials arrive early, it can replace Cashfree as the second v1 gateway with no design change.
- **Methods:** UPI, card, netbanking (the methods all supported gateways share).
- Failure classification (customer vs gateway vs unknown) per gateway, from the gateway's error codes.
- Per-`(gateway, method)` health tracking with automatic failover and automatic recovery.
- Retry routing: a retry never goes back to the gateway that just failed, unless no other gateway is usable.
- Published to npm as **`gateway-guard`** (name confirmed free on 2026-10-25), with CI, tests, and a README
  that explains the routing visually.
- A **live demo** (section 8) that non-technical clients can click through and watch failover happen.

## 3. Non-goals (v1)

- Hosting a webhook server. It's a library: the consumer's app owns its routes and calls `verifyWebhook()`.
  *(Decided earlier; don't re-litigate.)*
- Storing credentials. Keys are passed to the constructor by the consumer, from their own env vars.
- Shared/persistent health state across processes (Redis etc.). v1 keeps state **in memory, per process**,
  behind an interface so a store can be plugged in later (v2).
- Refunds, subscriptions/recurring mandates, payouts, settlements (later versions).
- Handling or storing card numbers. Each gateway's own hosted checkout or JS SDK collects payment details.
- Moving a customer mid-payment. Once a customer is on a gateway's payment page, the switch can only happen on
  the next payment or retry.

## 4. Anti-goals (would make v1 a failure even if it "works")

- Marking a gateway unhealthy because customers cancelled. That's the bug this project exists to avoid.
- Any path that could **charge a customer twice** for one order (e.g. a retry creating a second live payment
  while the first could still succeed). See section 6.4.
- Leaking keys or secrets in logs, errors or the demo UI.
- Claiming support for a gateway that hasn't been tested end to end against its sandbox. The README must say
  plainly what's tested.
- A demo that looks like a real store or could take real money. Test mode only, clearly labelled.

## 5. Constraints

- TypeScript, strict. Node.js **≥ 18** (Hostinger supports 18–24). Use built-in `fetch`; avoid runtime
  dependencies (drop the `axios` dependency in the current `package.json`).
- Ship ESM + CJS builds with type declarations.
- ~10 hours/week of Nihar's time. Target: **v1 in about 6 weeks** (library ~4–5 weeks + demo ~1–1.5 weeks).
- MIT license.

## 6. How it works

### 6.1 Building blocks

| Block | Responsibility |
|---|---|
| **Gateway adapter** (one per gateway) | Speaks the gateway's API: create payment, fetch/verify payment, verify webhook signature, and **classify** the gateway's errors. Returns normalized shapes. |
| **Failure classifier** | Part of each adapter: maps that gateway's error codes/statuses to `customer` · `gateway` · `unknown`. The mapping tables are data, unit-tested, and documented in the README. |
| **Health tracker** | Keeps a sliding window of outcomes per `(gateway, method)` and decides `healthy` · `degraded` · `down` (circuit breaker: closed → open → half-open). |
| **Router** | Picks the gateway for a new payment or a retry, using health + configured priority + the retry rule. |
| **Attempt registry** | Remembers recent attempts (in memory, with a TTL) so a retry knows which gateway failed and so outcomes can be attributed to the right `(gateway, method)`. |
| **Event emitter** | Emits normalized events (`attempt.created`, `attempt.succeeded`, `attempt.failed` with its classification, `health.changed`, `route.failover`), for logging, metrics, and the demo's live feed. |

### 6.2 Public API (shape, not final names)

```ts
const guard = new GatewayGuard({
  gateways: {
    razorpay: { keyId, keySecret, webhookSecret },
    cashfree: { appId, secretKey, webhookSecret, env: "sandbox" },
  },
  priority: ["razorpay", "cashfree"],       // preferred order when all are healthy
  health: { windowSize, failureThreshold, cooldownMs },   // sensible defaults provided
});

// New payment, or a retry of a failed attempt:
const attempt = await guard.createPayment({ orderId, amount, currency: "INR", method: "netbanking",
                                            customer, retryOf?: previousAttemptId });
// → { attemptId, gateway, checkout }   `checkout` tells the frontend which gateway SDK to open, with what data

const result = await guard.verifyPayment(attemptId, gatewayCallbackPayload);    // after the checkout returns
const event  = guard.verifyWebhook(gatewayName, rawBody, headers);              // inside the consumer's route
// verifyPayment / verifyWebhook also feed the outcome into the health tracker automatically.

guard.health();      // snapshot of every (gateway, method) state, for dashboards
guard.on("route.failover", e => …);
```

Because each gateway's checkout works differently (Razorpay: order + Checkout.js; Cashfree: payment session +
its JS SDK; PhonePe: redirect), `checkout` is a small tagged object, and the README ships a tiny browser
snippet showing how to launch each one.

### 6.3 Health rules (defaults; configurable)

- Only `gateway`-classified failures and timeouts count against health. `customer` failures are recorded for
  stats but **ignored** for health. `unknown` counts at half weight *(builder may tune)*.
- **down (open):** failure rate over the recent window (e.g. last 20 attempts or 5 minutes) above a threshold,
  e.g. ≥ 50% with at least 5 counted attempts. The router skips this pair.
- **Cool-down:** after `cooldownMs` (e.g. 60 s) the pair goes **half-open**: a small share of new payments
  is allowed through as a probe. Successes close the circuit; another failure re-opens it.
- If **every** gateway for a method is down, route to the least-bad one and emit an event, rather than refusing
  to take payment.

### 6.4 Retry routing and double-charge safety

- `createPayment({ retryOf })` routes to the highest-priority **usable gateway other than the one that failed**.
  If none exists, it falls back to the original gateway *(Nihar's rule; fallback is the builder's call, recorded here)*.
- Before routing a retry, the library checks the previous attempt's final status with its gateway. If it is
  actually paid, or still pending, the retry is **refused** with a clear error, so a customer can't end up paying
  twice. Exact behaviour for long-pending attempts is left to the builder, but must err on the side of not
  double-charging.
- Each attempt gets its own gateway order/session, linked to the consumer's `orderId`.

## 7. Quality bar (this is what visitors judge)

- Unit tests for the classifier tables, health tracker (with a fake clock), router, and retry rules. Aim for
  high coverage on these core modules.
- Adapter contract tests against **recorded/mocked HTTP responses** built from each gateway's documentation, so CI
  needs no credentials. Optional sandbox smoke tests, run only when keys are present in env.
- A **simulation test** that reproduces the README story: netbanking on gateway A starts failing → A goes down
  → new netbanking payments go to B (UPI still goes to A) → after cool-down A is probed → recovers.
- GitHub Actions CI (lint, typecheck, tests, build) on every push; badges in the README.
- README: the problem in one paragraph, a routing diagram, the classification tables, a quick start, the demo
  link, and an honest "tested against" section.
- Semantic versioning; a CHANGELOG.

## 8. Live demo: for clients

A small public web app at **`pay.vyapzy.com`** *(name and host are the builder's call: Nihar's friend's Hostinger
Business plan supports Node.js apps with GitHub auto-deploy, as long as it stays within the plan's limits)*. It uses
the published `gateway-guard` package exactly like any developer would.

- **Checkout:** a fake product with a "Pay ₹499" button; choose UPI, card or netbanking; pay in the gateway's
  **test mode** (no real money, clearly labelled "Demo · test mode").
- **Control panel:** switches such as "Make Razorpay netbanking fail" or "Make Cashfree UPI time out". Real
  sandboxes can't fail on demand, so the demo wraps the real adapters in a **fault-injecting wrapper**
  (demo-only code, not part of the library) that returns gateway-classified failures when a switch is on.
- **Health board:** each `(gateway, method)` shown green, amber or red, updating live.
- **Event feed:** human-readable lines, e.g. "Payment #12 → Razorpay netbanking failed (bank error) → retry
  routed to Cashfree ✓" and "Customer cancelled: not counted against Razorpay".
- A public demo needs light protection: rate limiting, and control-panel state that resets itself after a few
  minutes so one visitor's switches don't confuse the next.

## 9. What Nihar needs to provide

- A **Razorpay test-mode account** (free, instant) → test key ID/secret + webhook secret.
- A **Cashfree sandbox account** (free, instant) → sandbox app ID/secret.
- **PhonePe UAT credentials** when available (for v1.1).
- An **npm account** (to publish `gateway-guard` under his name) and a **public GitHub repo**
  `pithavanihar/gateway-guard`.
- These are created by Nihar; keys are given to the code only via env vars, never committed.

## 10. Left to the builder

Module layout, exact names, default thresholds and window sizes (within the rules above), the build tool,
the test framework, the demo's frontend stack, how the demo resets state, and the README visuals.

## 11. Success looks like

- `npm install gateway-guard` works, CI is green, and the README tells the story in under two minutes.
- A client can open `pay.vyapzy.com`, flip "Make Razorpay netbanking fail", and watch the next netbanking
  payment go to Cashfree while UPI stays on Razorpay.
- The repo is pinned on Nihar's GitHub, and the profile README's "in progress" line is replaced with links.
