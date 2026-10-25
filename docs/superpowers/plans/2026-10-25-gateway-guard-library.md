# gateway-guard library v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `gateway-guard` 1.0.0 on npm: one TypeScript API over Razorpay + Cashfree that routes each payment
to a healthy `(gateway, method)` pair, ignores customer-caused failures, and sends retries to a different gateway.

**Architecture:** Small, independently tested modules: a health tracker (circuit breaker per `(gateway, method)`), a
router, an in-memory attempt registry, and one adapter per gateway that speaks its HTTP API and classifies its errors.
A `GatewayGuard` class composes them and emits typed events. There are no runtime dependencies; HTTP uses the
built-in `fetch`, and clocks and randomness are injectable for tests.

**Tech Stack:** TypeScript 5 (strict), Node ≥ 18, tsup (ESM + CJS + .d.ts), Vitest (+ v8 coverage), Prettier,
GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-25-gateway-guard-design.md`. The live demo (spec §8) is a **separate
plan**, written after this library is published.

## Global Constraints

- Node.js **≥ 18**; `"engines": { "node": ">=18" }`. CI matrix: Node 18, 20, 22.
- **Zero runtime dependencies.** Remove `axios` (and jest) from the existing `package.json`. Use global `fetch`.
- Ship ESM + CJS + type declarations; `"files": ["dist"]`. MIT license. Author "Nihar Pithava".
- Credentials only through the constructor. Never log or put keys or secrets in error messages (tests assert this).
- In-memory, per-process state only (no Redis).
- Amounts are integer **paise** (`amountMinor`) in the public API; currency `"INR"` only in v1.
- Methods: `"upi" | "card" | "netbanking"`. Gateways in v1: `"razorpay" | "cashfree"`. The type also includes
  `"phonepe"` for v1.1 but no adapter is built now.
- Health defaults (spec §6.3): windowSize 20, windowMs 300_000, minAttempts 5, failureThreshold 0.5,
  degradedThreshold 0.25, cooldownMs 60_000, probeRatio 0.2, unknownWeight 0.5.
- Only `gateway` and `unknown` failures (and timeouts, classified `gateway`) affect health; `customer` never does.
- Gateway API details (endpoints, field names, error codes) must be checked against the gateway's **current
  official docs** when writing each adapter. Test fixtures are copied from those docs, with the doc URL in a comment.

## Review Focus

1. **The same outcome reported twice** (callback + webhook, or a webhook redelivered) must count **once** toward health. Pinned in Task 4 + Task 7.
2. **A webhook for an attempt this process doesn't know** (restart wiped memory) still returns a normalized event, doesn't throw, and doesn't change health. Pinned in Task 7.
3. **A tampered signature, missing signature header, or a body re-serialized from JSON** must throw `InvalidSignatureError` and must not change health. Pinned in Tasks 5, 6.
4. **A retry when the previous attempt is paid, pending, or its status can't be fetched** must be refused (`RetryNotAllowedError`), so a customer is never charged twice. Pinned in Task 7.
5. **Bad amounts** (0, negative, fractional paise, `NaN`) are rejected before any network call; Cashfree's rupee conversion is exact (49900 → 499, 1 → 0.01). Pinned in Tasks 1, 6.

---

## File structure

```
src/
  index.ts                     public exports only
  types.ts                     shared types (GatewayName, PaymentMethod, Classification, Checkout, events…)
  errors.ts                    error classes
  validate.ts                  input validation (amounts, method, ids)
  events.ts                    typed event emitter
  http.ts                      fetchJson(): timeout, JSON parse, GatewayRequestError mapping
  health/HealthTracker.ts      circuit breaker per (gateway, method)
  router/Router.ts             choose gateway for new payment / retry
  attempts/AttemptRegistry.ts  in-memory attempts with TTL; once-only final outcome
  adapters/Adapter.ts          GatewayAdapter interface
  adapters/razorpay/classify.ts, adapters/razorpay/RazorpayAdapter.ts
  adapters/cashfree/classify.ts, adapters/cashfree/CashfreeAdapter.ts
  GatewayGuard.ts              the facade
test/
  (mirrors src/) + fixtures/razorpay/*.json, fixtures/cashfree/*.json, simulation.test.ts, sandbox/*.smoke.ts
```

---

### Task 1: Project setup, shared types, errors, validation

**Files:**
- Modify: `package.json` (replace contents; keep name, description, keywords, author, license)
- Create: `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.prettierrc`, `.gitignore`, `LICENSE`,
  `.github/workflows/ci.yml`, `src/types.ts`, `src/errors.ts`, `src/validate.ts`, `src/index.ts`
- Test: `test/validate.test.ts`, `test/errors.test.ts`

**Interfaces:**
- Produces (`src/types.ts`):
  `type GatewayName = "razorpay" | "cashfree" | "phonepe"`;
  `type PaymentMethod = "upi" | "card" | "netbanking"`;
  `type Classification = "customer" | "gateway" | "unknown"`;
  `type AttemptStatus = "created" | "pending" | "paid" | "failed"`;
  `interface Customer { id: string; phone: string; email?: string; name?: string }`;
  `type Checkout = { gateway: "razorpay"; keyId: string; orderId: string; amountMinor: number; currency: "INR"; method: PaymentMethod } | { gateway: "cashfree"; paymentSessionId: string; mode: "sandbox" | "production"; method: PaymentMethod }`;
  `interface Outcome { status: "paid" | "failed" | "pending"; classification?: Classification; reason?: string; method?: PaymentMethod }`.
- Produces (`src/errors.ts`): `GatewayGuardError` (base, `code: string`); `ValidationError`;
  `InvalidSignatureError(gateway)`; `RetryNotAllowedError(reason: "paid" | "pending" | "status-unknown" | "unknown-attempt")`;
  `NoGatewayAvailableError(method)`; `GatewayRequestError(gateway, httpStatus | null, classification, reason)`;
  `TimeoutError extends GatewayRequestError` (classification `"gateway"`, reason `"timeout"`).
- Produces (`src/validate.ts`): `validatePaymentInput(input: { orderId: string; amountMinor: number; currency: string; method: string; customer: Customer }): void` (throws `ValidationError`).

- [ ] **Step 1:** `git init`; set `package.json` to: `"type": "module"`, `"exports"` with `import`/`require`/`types`
  pointing at `dist/index.js`, `dist/index.cjs`, `dist/index.d.ts`; scripts `build` (tsup), `test` (vitest run),
  `test:cov`, `typecheck` (tsc --noEmit), `format:check`, `check` (typecheck + format:check + test); devDependencies
  typescript, tsup, vitest, @vitest/coverage-v8, prettier, @types/node; `"engines": {"node": ">=18"}`; no
  `dependencies`. Run `npm install`. Expected: no `axios` under `node_modules`.
- [ ] **Step 2: Write failing tests** `test/validate.test.ts`:
  `it.each([0, -100, 10.5, NaN, Infinity])("rejects amountMinor %s", …)` → throws `ValidationError`;
  rejects currency `"USD"`, method `"wallet"`, empty `orderId`, `orderId` longer than 40 chars, customer without phone;
  accepts `{ orderId: "ord_1", amountMinor: 49900, currency: "INR", method: "upi", customer: { id: "c1", phone: "9999999999" } }`.
  `test/errors.test.ts`: every error is `instanceof GatewayGuardError` with a stable `code`
  (`"VALIDATION"`, `"INVALID_SIGNATURE"`, `"RETRY_NOT_ALLOWED"`, `"NO_GATEWAY"`, `"GATEWAY_REQUEST"`, `"TIMEOUT"`).
- [ ] **Step 3:** Run `npx vitest run` → FAIL (modules missing).
- [ ] **Step 4:** Implement `types.ts`, `errors.ts`, `validate.ts`; `index.ts` re-exports types and errors.
  Configure tsup (`entry: ["src/index.ts"], format: ["esm","cjs"], dts: true, clean: true`).
- [ ] **Step 5:** Run `npm run check && npm run build` → PASS; `dist/` has `.js`, `.cjs`, `.d.ts`.
- [ ] **Step 6:** CI workflow: on push/PR, Node 18/20/22 matrix: `npm ci`, `npm run check`, `npm run build`.
- [ ] **Step 7: Commit** (include `docs/`):
  `git add -A && git commit -m "chore: project setup, shared types, errors and input validation"`

---

### Task 2: HealthTracker (circuit breaker per gateway + method)

**Files:**
- Create: `src/health/HealthTracker.ts`
- Test: `test/health/HealthTracker.test.ts`

**Interfaces:**
- Consumes: `GatewayName`, `PaymentMethod`, `Classification` (Task 1).
- Produces:
  `interface HealthOptions { windowSize; windowMs; minAttempts; failureThreshold; degradedThreshold; cooldownMs; probeRatio; unknownWeight }` (all numbers; defaults in Global Constraints);
  `type CircuitState = "closed" | "open" | "half-open"`;
  `type HealthLabel = "healthy" | "degraded" | "down"`;
  `interface PairHealth { gateway; method; state: CircuitState; label: HealthLabel; failureRate: number; countedAttempts: number; openedAt?: number }`;
  `class HealthTracker { constructor(opts?: Partial<HealthOptions>, deps?: { now?: () => number; random?: () => number }); record(gateway, method, outcome: { ok: true } | { ok: false; classification: Classification }): void; isUsable(gateway, method): boolean; get(gateway, method): PairHealth; snapshot(): PairHealth[]; onChange(cb: (h: PairHealth, prev: HealthLabel) => void): void }`.

Rules (the algorithm the tests pin down):
- `customer` failures are ignored entirely. Success weight 1; `gateway` failure weight 1; `unknown` weight `unknownWeight`.
- The window holds the last `windowSize` counted outcomes that are younger than `windowMs`.
- `closed` → `open` when counted weight ≥ `minAttempts` and failure weight / counted weight ≥ `failureThreshold`.
- `open` → `half-open` once `now - openedAt ≥ cooldownMs` (checked lazily in `isUsable`/`get`).
- In `half-open`, `isUsable` returns `random() < probeRatio`. A success clears the window → `closed`; a failure →
  `open` again with a fresh `openedAt`.
- Label: `open` → `down`; `half-open` → `degraded`; `closed` with failure rate ≥ `degradedThreshold` → `degraded`; otherwise `healthy`.
- `onChange` fires only when the label changes.

- [ ] **Step 1: Write failing tests** with a fake clock (`let t = 0; now: () => t`) and `random: () => 0.1`:
  - `"customer cancellations never open the circuit"`: 50 × `{ok:false, classification:"customer"}` → `get(...).state === "closed"`, `label === "healthy"`.
  - `"opens at 50% gateway failures with at least 5 attempts"`: 2 ok + 3 gateway failures → `"open"`; with only 4 recorded (1 ok + 3 fail) → still `"closed"`.
  - `"unknown failures count half"`: 5 ok + 4 unknown (2/7 ≈ 0.29) → `"closed"`, label `"degraded"`.
  - `"isolated per method"`: open razorpay/netbanking; `isUsable("razorpay","upi") === true`.
  - `"outcomes older than windowMs drop out"`: 3 failures at t=0, advance 300_001, 3 successes → `"closed"`.
  - `"half-open after cooldown, probes by probeRatio"`: open; t += 60_000 → `get().state === "half-open"`; `isUsable` true with random 0.1, false with random 0.5.
  - `"probe success closes, probe failure reopens"`.
  - `"onChange fires on label change only"`.
- [ ] **Step 2:** `npx vitest run test/health` → FAIL.
- [ ] **Step 3:** Implement `HealthTracker` per the rules above (a Map keyed `${gateway}:${method}`).
- [ ] **Step 4:** `npx vitest run test/health` → PASS.
- [ ] **Step 5: Commit** `feat(health): circuit breaker per gateway and payment method`

---

### Task 3: Router

**Files:**
- Create: `src/router/Router.ts`
- Test: `test/router/Router.test.ts`

**Interfaces:**
- Consumes: `HealthTracker` (`isUsable`, `get`), `GatewayName`, `PaymentMethod`.
- Produces: `type RouteReason = "preferred" | "failover" | "retry" | "all-down"`; `class Router { constructor(health: HealthTracker, priority: GatewayName[], supports: (g: GatewayName, m: PaymentMethod) => boolean); choose(method: PaymentMethod, opts?: { avoid?: GatewayName; exclude?: GatewayName[] }): { gateway: GatewayName; reason: RouteReason } }` and `candidates(method, opts?): GatewayName[]` (ordered, for creation-time failover). Throws `NoGatewayAvailableError` when no configured gateway supports the method.

Rules: walk `priority`, keeping gateways that support the method and aren't in `exclude`. With `avoid` set (a retry), the
first usable one that isn't `avoid` wins (`"retry"`). If none qualifies, use `avoid` itself if it's usable. Otherwise the
first usable wins (`"preferred"` if it's `priority[0]` among supporting gateways, else `"failover"`). If nothing is usable,
pick the supporting gateway with the lowest `failureRate` (`"all-down"`).

- [ ] **Step 1: Write failing tests:** `"prefers priority order when all healthy"` → razorpay/`preferred`;
  `"fails over when the preferred pair is down"` (open razorpay/netbanking) → cashfree/`failover`, while `choose("upi")` → razorpay;
  `"retry avoids the failed gateway even when healthy"` → `choose("upi",{avoid:"razorpay"})` → cashfree/`retry`;
  `"retry falls back to the original when no alternative is usable"`;
  `"all down picks lowest failure rate"` → reason `"all-down"`;
  `"no gateway supports the method"` → throws `NoGatewayAvailableError`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(router): health-aware routing with retry avoidance`

---

### Task 4: AttemptRegistry

**Files:**
- Create: `src/attempts/AttemptRegistry.ts`
- Test: `test/attempts/AttemptRegistry.test.ts`

**Interfaces:**
- Produces: `interface Attempt { attemptId: string; orderId: string; gateway: GatewayName; method: PaymentMethod; gatewayRef: string; amountMinor: number; createdAt: number; final?: "paid" | "failed" }`;
  `class AttemptRegistry { constructor(deps?: { now?: () => number; ttlMs?: number /* default 86_400_000 */ }); add(a: Omit<Attempt,"final">): void; get(attemptId): Attempt | undefined; findByGatewayRef(gateway, gatewayRef): Attempt | undefined; markFinal(attemptId, status: "paid" | "failed"): boolean /* true only the first time */; prune(): void }`.
- `newAttemptId(): string` exported from the same file: `"att_" + crypto.randomUUID()` (Node ≥ 18 global `crypto`).

- [ ] **Step 1: Write failing tests:** `"markFinal returns true once, then false"` (Review Focus #1);
  `"findByGatewayRef finds the attempt"`; `"expired attempts are pruned after ttl"` (fake clock); `"newAttemptId is unique and prefixed"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (two Maps; prune lazily on `add`). **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `feat(attempts): in-memory attempt registry with once-only outcomes`

---

### Task 5: HTTP helper + Razorpay adapter

**Files:**
- Create: `src/http.ts`, `src/adapters/Adapter.ts`, `src/adapters/razorpay/classify.ts`, `src/adapters/razorpay/RazorpayAdapter.ts`
- Create fixtures: `test/fixtures/razorpay/{order.created.json, payment.captured.json, payment.failed.bank.json, payment.failed.cancelled.json, webhook.payment.failed.json}`
- Test: `test/http.test.ts`, `test/adapters/razorpay/classify.test.ts`, `test/adapters/razorpay/RazorpayAdapter.test.ts`

**Interfaces:**
- Produces (`src/http.ts`): `fetchJson<T>(gateway: GatewayName, url: string, init: RequestInit, deps: { fetch: typeof fetch; timeoutMs: number }): Promise<T>`. Aborts after `timeoutMs` → `TimeoutError`; network error → `GatewayRequestError(…, null, "gateway", "network")`; HTTP 5xx → classification `"gateway"`; 4xx → `"unknown"`. The error message never contains request headers or body.
- Produces (`src/adapters/Adapter.ts`):
  `interface CreateOrderInput { attemptId; orderId; amountMinor; currency: "INR"; method: PaymentMethod; customer: Customer }`;
  `interface WebhookEvent { gateway: GatewayName; gatewayRef: string; eventId?: string; status: "paid" | "failed" | "other"; method?: PaymentMethod; classification?: Classification; reason?: string; raw: unknown }`;
  `interface GatewayAdapter { readonly name: GatewayName; supports(method: PaymentMethod): boolean; createOrder(input: CreateOrderInput): Promise<{ gatewayRef: string; checkout: Checkout }>; fetchStatus(gatewayRef: string): Promise<{ status: AttemptStatus } & Partial<Outcome>>; verifyCallback(gatewayRef: string, payload: unknown): Promise<Outcome>; verifyWebhook(rawBody: string | Uint8Array, headers: Record<string, string | string[] | undefined>): WebhookEvent }`.
- Produces: `classifyRazorpay(error: { source?: string; reason?: string; code?: string }): Classification`;
  `class RazorpayAdapter implements GatewayAdapter { constructor(cfg: { keyId: string; keySecret: string; webhookSecret: string }, deps: { fetch: typeof fetch; timeoutMs: number }) }`.

Razorpay behaviour (check every line against https://razorpay.com/docs/api/ before coding):
- `createOrder`: `POST https://api.razorpay.com/v1/orders`, Basic auth `keyId:keySecret`, body
  `{ amount: amountMinor, currency, receipt: orderId, notes: { attemptId } }` → `gatewayRef = order.id`;
  `checkout = { gateway: "razorpay", keyId, orderId: order.id, amountMinor, currency, method }`.
- `verifyCallback(gatewayRef, { razorpay_payment_id, razorpay_order_id, razorpay_signature })`: the signature must equal
  hex HMAC-SHA256 of `${razorpay_order_id}|${razorpay_payment_id}` with `keySecret`, compared with
  `crypto.timingSafeEqual`, and `razorpay_order_id` must equal `gatewayRef`; otherwise `InvalidSignatureError`. Then
  `GET /v1/payments/{id}`: `captured`/`authorized` → paid; `failed` → failed + classification; otherwise pending.
- `fetchStatus`: `GET /v1/orders/{id}/payments`. Any captured/authorized → paid; any created/pending → pending;
  all failed → failed (last one's classification); none → created.
- `verifyWebhook`: header `x-razorpay-signature` = hex HMAC-SHA256(rawBody, webhookSecret). Map `payment.captured` → paid,
  `payment.failed` → failed, everything else → other; `gatewayRef = payload.payment.entity.order_id`;
  `eventId` from header `x-razorpay-event-id`.
- Classification table (`classify.ts`, data first, then a fallback by `error_source`): reasons such as
  `payment_cancelled`, `payment_timed_out` (customer didn't complete), `incorrect_otp`, `insufficient_funds`,
  `card_declined`-type customer reasons → `customer`; `bank_technical_error`, `gateway_technical_error`,
  `server_error` → `gateway`. Fallback: source `customer` → `customer`; `bank`/`gateway`/`internal` → `gateway`;
  anything else → `unknown`. Take the full reason list from Razorpay's error docs and cite the URL in the file.
- Method mapping from Razorpay's payment `method`: `upi`, `card`, `netbanking` (others → `undefined`).

- [ ] **Step 1: Write failing tests** with a stub `fetch` returning the fixtures:
  `http.test.ts`: `"times out → TimeoutError classified gateway"` (fetch never resolves; timeoutMs 20);
  `"5xx → gateway, 4xx → unknown"`; `"error message never contains the auth header"`.
  `classify.test.ts`: `it.each` over the table (≥ 3 rows per classification) plus fallback cases.
  `RazorpayAdapter.test.ts`: `"createOrder posts paise and returns checkout"` (assert URL, Basic auth header,
  body `amount: 49900`); `"verifyCallback accepts a valid signature"`; `"verifyCallback rejects a tampered signature"`
  and `"…an order id that doesn't match gatewayRef"` (Review Focus #3); `"verifyWebhook rejects missing header"`;
  `"verifyWebhook rejects a body that was JSON.parse'd and re-stringified"` (re-serialized whitespace changes the HMAC);
  `"payment.failed with source customer → classification customer"`; `"fetchStatus: one failed + one captured → paid"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `http.ts`, `Adapter.ts`, `classify.ts`, `RazorpayAdapter.ts`.
- [ ] **Step 4:** `npx vitest run test/http.test.ts test/adapters/razorpay` → PASS.
- [ ] **Step 5: Commit** `feat(razorpay): adapter with signature checks and failure classification`

---

### Task 6: Cashfree adapter

**Files:**
- Create: `src/adapters/cashfree/classify.ts`, `src/adapters/cashfree/CashfreeAdapter.ts`
- Create fixtures: `test/fixtures/cashfree/{order.created.json, payments.success.json, payments.failed.bank.json, payments.user_dropped.json, webhook.payment.failed.json}`
- Test: `test/adapters/cashfree/classify.test.ts`, `test/adapters/cashfree/CashfreeAdapter.test.ts`

**Interfaces:**
- Consumes: `GatewayAdapter`, `fetchJson`, types (Tasks 1, 5).
- Produces: `classifyCashfree(p: { payment_status: string; error_details?: { error_code?: string; error_reason?: string; error_source?: string } }): Classification`;
  `class CashfreeAdapter implements GatewayAdapter { constructor(cfg: { appId: string; secretKey: string; env: "sandbox" | "production" }, deps: { fetch: typeof fetch; timeoutMs: number }) }`;
  exported helper `paiseToRupees(amountMinor: number): number`.

Cashfree behaviour (API version header `x-api-version: 2023-08-01`; check against https://docs.cashfree.com/reference/pg-new-apis-endpoint):
- Base URL `https://sandbox.cashfree.com/pg` or `https://api.cashfree.com/pg`; headers `x-client-id`, `x-client-secret`.
- `createOrder`: `POST /orders` with `{ order_id: attemptId, order_amount: paiseToRupees(amountMinor), order_currency, customer_details: { customer_id, customer_phone, customer_email?, customer_name? }, order_meta: { payment_methods } , order_tags: { orderId } }`, where `payment_methods` maps `upi → "upi"`, `card → "cc,dc"`, `netbanking → "nb"`. `gatewayRef = attemptId` (Cashfree's `order_id`); `checkout = { gateway: "cashfree", paymentSessionId, mode: env, method }`.
- `fetchStatus` / `verifyCallback(gatewayRef, payload)`: Cashfree's return URL carries no signature, so always confirm server-side with `GET /orders/{order_id}/payments`: any `SUCCESS` → paid; any `PENDING` → pending; `FAILED`/`USER_DROPPED`/`CANCELLED` → failed with classification; none or only `NOT_ATTEMPTED` → created. `verifyCallback` ignores client-provided status.
- `verifyWebhook`: headers `x-webhook-signature` and `x-webhook-timestamp`; signature = base64 HMAC-SHA256(`timestamp + rawBody`, secretKey). Map `PAYMENT_SUCCESS_WEBHOOK` → paid, `PAYMENT_FAILED_WEBHOOK` / `PAYMENT_USER_DROPPED_WEBHOOK` → failed, else other; `gatewayRef = data.order.order_id`.
- Classification: `USER_DROPPED` and `CANCELLED` → `customer`; `error_source` `customer` → `customer`; `bank` / `cashfree` / `gateway` → `gateway`; anything else → `unknown`, with a reason-code table from Cashfree's docs layered on top.
- Method from `payment_group`: `upi*` → upi; `credit_card`/`debit_card` → card; `net_banking` → netbanking.

- [ ] **Step 1: Write failing tests:** `"paiseToRupees is exact"`: `it.each([[49900, 499], [1, 0.01], [12345, 123.45]])` (Review Focus #5);
  `"createOrder sends rupees, method filter and api version"`; `"verifyCallback trusts only the server lookup"`
  (client payload says SUCCESS, fixture says FAILED → failed); `"USER_DROPPED is a customer failure"`;
  `"FAILED with bank source is a gateway failure"`; `"verifyWebhook accepts valid / rejects tampered / rejects missing timestamp"`;
  `"sandbox vs production base URL"`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npx vitest run test/adapters/cashfree` → PASS.
- [ ] **Step 5: Commit** `feat(cashfree): adapter with server-side verification and classification`

---

### Task 7: GatewayGuard facade (create, retry, verify, webhooks, events)

**Files:**
- Create: `src/events.ts`, `src/GatewayGuard.ts`; Modify: `src/index.ts`
- Test: `test/GatewayGuard.test.ts` (uses fake adapters implementing `GatewayAdapter`, no HTTP)

**Interfaces:**
- Consumes: everything above.
- Produces:
  `type GuardEvent = { type: "attempt.created"; attempt: Attempt; reason: RouteReason } | { type: "attempt.succeeded"; attempt: Attempt } | { type: "attempt.failed"; attempt: Attempt; classification: Classification; reason?: string; countedForHealth: boolean } | { type: "health.changed"; health: PairHealth; previous: HealthLabel } | { type: "route.failover"; method: PaymentMethod; from: GatewayName; to: GatewayName; why: "unhealthy" | "create-error" | "retry" } | { type: "webhook.unmatched"; event: WebhookEvent }`;
  `class GatewayGuard { constructor(opts: GatewayGuardOptions); createPayment(input: { orderId; amountMinor; currency: "INR"; method; customer; retryOf?: string }): Promise<{ attemptId: string; gateway: GatewayName; checkout: Checkout }>; verifyPayment(attemptId: string, callbackPayload: unknown): Promise<Outcome>; verifyWebhook(gateway: GatewayName, rawBody: string | Uint8Array, headers: Record<string, string | string[] | undefined>): WebhookEvent; health(): PairHealth[]; on(type, listener): () => void }`;
  `interface GatewayGuardOptions { gateways: { razorpay?: RazorpayConfig; cashfree?: CashfreeConfig }; priority: GatewayName[]; health?: Partial<HealthOptions>; timeoutMs?: number /* 15_000 */; adapters?: GatewayAdapter[] /* test/demo injection; overrides built-ins by name */; now?: () => number; random?: () => number; fetch?: typeof fetch }`.

Behaviour:
- `createPayment`: validate; if `retryOf` is set, look up that attempt (missing → `RetryNotAllowedError("unknown-attempt")`),
  call its adapter's `fetchStatus`: `paid` → `RetryNotAllowedError("paid")`; `pending` or `created` →
  `RetryNotAllowedError("pending")`; a thrown error → `RetryNotAllowedError("status-unknown")`; `failed` → route with
  `avoid` = that gateway. Then try `router.candidates` in order: on a `GatewayRequestError` from `createOrder`, record a
  health failure (its classification) and try the next (emit `route.failover` with `"create-error"`). If every
  candidate fails, rethrow the last error. Register the attempt; emit `attempt.created`.
- `verifyPayment` / `verifyWebhook`: once the outcome is final (`paid`/`failed`) and `registry.markFinal` returns true,
  record health (`ok` for paid; for failed, `customer` classification is recorded but ignored by the tracker) and emit
  `attempt.succeeded`/`attempt.failed`. A second report of the same attempt changes nothing.
- `verifyWebhook` for an unknown `gatewayRef`: return the event, emit `webhook.unmatched`, no health change.
- Forward `HealthTracker.onChange` as `health.changed`.

- [ ] **Step 1: Write failing tests** (fake adapters, fake clock):
  `"routes netbanking away from an unhealthy pair, keeps upi"`;
  `"customer cancellations don't trigger failover"` (10 failed attempts classified customer → next still razorpay);
  `"retry goes to the other gateway"` → cashfree, and a `route.failover` event with `why: "retry"`;
  `"retry refused when previous attempt is paid"`, `"…pending"`, `"…status lookup throws"` → `RetryNotAllowedError` with
  reasons `paid`, `pending`, `status-unknown` (Review Focus #4);
  `"createOrder error on first gateway fails over at creation"`;
  `"callback then webhook for the same attempt counts once"`: `health()` counted attempts === 1 (Review Focus #1);
  `"unknown webhook returns the event, emits webhook.unmatched, health unchanged"` (Review Focus #2);
  `"invalid webhook signature throws and health unchanged"` (Review Focus #3);
  `"validation errors make no adapter calls"` (Review Focus #5).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement `events.ts` (a small typed emitter) and `GatewayGuard.ts`;
  export `GatewayGuard`, types and errors from `index.ts`.
- [ ] **Step 4:** `npm run check` → PASS.
- [ ] **Step 5: Commit** `feat: GatewayGuard facade with failover, safe retries and once-only outcomes`

---

### Task 8: Simulation test + sandbox smoke tests

**Files:**
- Create: `test/simulation.test.ts`, `test/sandbox/razorpay.smoke.ts`, `test/sandbox/cashfree.smoke.ts`, `vitest.sandbox.config.ts`
- Modify: `package.json` (script `test:sandbox`)

**Interfaces:**
- Consumes: `GatewayGuard` with `adapters` injection; `RazorpayAdapter`, `CashfreeAdapter`.

- [ ] **Step 1: Write the simulation test** (spec §7), using fake adapters and a fake clock. It must read like the README
  story and assert at each stage:
  1. all healthy → netbanking and upi both go to razorpay;
  2. razorpay netbanking returns 5 gateway failures → `health()` shows razorpay/netbanking `down`;
  3. the next netbanking payment → cashfree with a `route.failover` event; the next upi payment → still razorpay;
  4. 20 customer-cancelled upi failures on razorpay → razorpay/upi still `healthy`;
  5. advance 60 s → razorpay/netbanking `degraded` (half-open); a probe succeeds → `healthy`; netbanking routes to razorpay again.
- [ ] **Step 2:** Run `npx vitest run test/simulation.test.ts` → PASS. (Tasks 2–7 already implement it. If it fails, fix the module at fault, not the test.)
- [ ] **Step 3:** Sandbox smoke tests (run only when env vars are present; otherwise `describe.skip`):
  `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` → `createOrder` returns `order_…`, and `fetchStatus` → `created`;
  `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY` → `createOrder` returns a `paymentSessionId`. Script:
  `"test:sandbox": "vitest run --config vitest.sandbox.config.ts"`. CI doesn't run it.
- [ ] **Step 4:** Nihar creates the Razorpay test and Cashfree sandbox accounts and runs `npm run test:sandbox` locally
  with keys in a git-ignored `.env.local` → PASS. **This is the evidence for the README's "tested against" section.**
- [ ] **Step 5: Commit** `test: failover simulation and env-gated sandbox smoke tests`

---

### Task 9: README, release, publish

**Files:**
- Create: `README.md`, `CHANGELOG.md`, `docs/routing.svg` (or a Mermaid diagram inline), `examples/server-express.ts`, `examples/browser-checkout.html`
- Modify: `package.json` (`version: "1.0.0"`, `repository`, `homepage`, `bugs`), `C:\Users\nihar\github-profile\README.md`

- [ ] **Step 1: README** in this order: one-paragraph problem; the three rules (customer failures don't count;
  health per gateway + method; retries go elsewhere); routing diagram; quick start (install, constructor,
  `createPayment`, `verifyPayment`, webhook route); classification tables for both gateways (generated from the
  `classify.ts` data, so they can't drift); configuration defaults; events; **"Tested against"**, listing only what
  Task 8 Step 4 actually ran; "Not in v1" (from the spec's non-goals); roadmap (PhonePe v1.1, pluggable store v2); CI and npm badges.
- [ ] **Step 2: Examples:** `examples/server-express.ts` (create, verify and webhook routes; the webhook uses the
  *raw* body); `examples/browser-checkout.html` (launch Razorpay Checkout.js or Cashfree's JS SDK from the `checkout` object).
  `npx tsc --noEmit examples/server-express.ts` passes (Express as a devDependency only).
- [ ] **Step 3:** `npm run check && npm run build && npm pack --dry-run`: the tarball contains only `dist/`, `README.md`,
  `LICENSE`, `package.json`, and `dependencies` is empty.
- [ ] **Step 4: Publish (Nihar does the account steps):** create public repo `pithavanihar/gateway-guard` and push;
  CI green; Nihar runs `npm login` then `npm publish --access public`; tag `v1.0.0`.
- [ ] **Step 5: Profile:** in `~/github-profile/README.md`, replace the "in progress" line with links to the repo and npm
  package; pin `gateway-guard` on GitHub (replacing `Event-RSVP-System`).
- [ ] **Step 6: Commit** `docs: README, examples and v1.0.0 release`

---

## Self-review notes

- Spec coverage: §2 goals → Tasks 2–7, 9; §6.3 health → Task 2; §6.4 retry and double-charge safety → Task 7;
  §7 quality → Tasks 1 (CI), 5–6 (contract fixtures), 8 (simulation, sandbox), 9 (README); §9 accounts → Task 8 Step 4, Task 9 Step 4;
  §8 demo → separate plan (stated in header).
- One deviation from the spec sketch: Cashfree signs webhooks with the client secret, so its config has no separate
  `webhookSecret` (Task 6).
