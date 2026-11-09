// Minimal Express server around gateway-guard. Run it with:  npx tsx examples/server-express.ts
// Keys come from the environment; never commit them.
import express from "express";
import {
  GatewayGuard,
  InvalidSignatureError,
  RetryNotAllowedError,
  ValidationError,
  type GatewayName,
} from "../src/index.js"; // in your own project: from "gateway-guard"

const guard = new GatewayGuard({
  gateways: {
    razorpay: {
      keyId: process.env.RAZORPAY_KEY_ID ?? "",
      keySecret: process.env.RAZORPAY_KEY_SECRET ?? "",
      webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET ?? "",
    },
    cashfree: {
      appId: process.env.CASHFREE_APP_ID ?? "",
      secretKey: process.env.CASHFREE_SECRET_KEY ?? "",
      env: "sandbox",
    },
  },
  priority: ["razorpay", "cashfree"],
});

guard.on("route.failover", (e) => console.log(`failover ${e.from} -> ${e.to} (${e.why})`));
guard.on("route.all-down", (e) => console.warn(`every gateway is down for ${e.method}`));
guard.on("order.multiple-payments", (e) => {
  // The customer paid the same order more than once. Refund the extra payments.
  console.error(`REFUND NEEDED: order ${e.orderId} was paid ${e.attempts.length} times`);
});

const app = express();

// Webhooks first, and with the RAW body: the signature is computed over the exact bytes the
// gateway sent, so a parsed-then-reserialised JSON body will fail verification.
app.post("/webhooks/:gateway", express.raw({ type: "*/*" }), (req, res) => {
  const gateway = req.params.gateway;
  if (gateway !== "razorpay" && gateway !== "cashfree") {
    res.sendStatus(404);
    return;
  }
  try {
    const event = guard.verifyWebhook(gateway as GatewayName, req.body as Buffer, req.headers);
    console.log(`webhook ${gateway}: ${event.status}`);
    res.sendStatus(200);
  } catch (err) {
    if (err instanceof InvalidSignatureError) {
      res.sendStatus(400);
      return;
    }
    throw err;
  }
});

app.use(express.json());

// 1. Create (or retry) a payment. The browser opens the gateway's checkout from `checkout`.
app.post("/payments", async (req, res) => {
  const { orderId, amountMinor, method, customer, retryOf } = req.body;
  try {
    const payment = await guard.createPayment({
      orderId,
      amountMinor,
      currency: "INR",
      method,
      customer,
      retryOf,
    });
    res.json(payment); // { attemptId, gateway, checkout }
  } catch (err) {
    if (err instanceof RetryNotAllowedError) {
      res.status(409).json({ error: "retry-not-allowed", reason: err.reason });
    } else if (err instanceof ValidationError) {
      res.status(400).json({ error: err.message });
    } else {
      console.error(err);
      res.status(502).json({ error: "no gateway could create the payment" });
    }
  }
});

// 1b. The customer closed the checkout without paying: hand back the SAME checkout so the
//     browser reopens it. No new gateway order, so no chance of paying twice. If it can no
//     longer be resumed (409), the browser retries with `retryOf` instead.
app.post("/payments/:attemptId/resume", (req, res) => {
  try {
    res.json(guard.resume(req.params.attemptId)); // { attemptId, gateway, checkout }
  } catch (err) {
    if (err instanceof RetryNotAllowedError) {
      res.status(409).json({ error: "resume-not-allowed", reason: err.reason });
    } else {
      throw err;
    }
  }
});

// 2. The browser posts back what the gateway's checkout returned. Verify it server-side.
app.post("/payments/:attemptId/verify", async (req, res) => {
  try {
    const outcome = await guard.verifyPayment(req.params.attemptId, req.body);
    res.json(outcome); // { status: "paid" | "failed" | "pending", ... }
  } catch (err) {
    if (err instanceof InvalidSignatureError) {
      res.status(400).json({ error: "invalid signature" });
    } else {
      console.error(err);
      res.status(500).json({ error: "verification failed" });
    }
  }
});

// 3. Health snapshot for a dashboard.
app.get("/health", (_req, res) => res.json(guard.health()));

app.listen(3000, () => console.log("listening on http://localhost:3000"));
