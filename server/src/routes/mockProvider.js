import { randomUUID } from "node:crypto";
import { Router } from "express";
import { prisma } from "../db.js";
import { signWebhookPayload, returnUrl } from "../billing/provider.js";

const router = Router();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

function formatMoney(amountMinor, currency) {
  const symbol = currency === "USD" || currency === "usd" ? "$" : `${currency} `;
  return `${symbol}${(amountMinor / 100).toFixed(2)}`;
}

function checkoutPage({ reference, plan, interval, amountMinor, currency }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Acme Payments — Test checkout</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         background: #eceff4; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1c2733; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 10px 30px rgba(20,30,50,.15);
          width: min(420px, 92vw); padding: 32px; }
  .muted { color: #5b6b7c; font-size: 14px; }
  .price { font-size: 40px; font-weight: 700; margin: 12px 0 4px; }
  .interval { text-transform: capitalize; color: #5b6b7c; }
  .row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e6eaf0; }
  .label { color: #5b6b7c; }
  .buttons { display: grid; gap: 12px; margin-top: 24px; }
  button { width: 100%; padding: 14px; border-radius: 10px; font-size: 16px; font-weight: 600; cursor: pointer; border: 1px solid transparent; }
  .pay { background: #1d4ed8; color: #fff; }
  .pay:hover { background: #1e40af; }
  .fail { background: #fff; color: #b91c1c; border-color: #fecaca; }
  .tag { display: inline-block; background: #fff3cd; color: #7a5c00; border-radius: 999px; padding: 3px 10px; font-size: 12px; }
</style>
</head>
<body>
  <div class="card">
    <span class="tag">TEST MODE — no real card is charged</span>
    <h1 style="margin:14px 0 0">Pro — ${escapeHtml(interval)}ly</h1>
    <p class="muted">This is a simulated hand-off to a payment provider.</p>
    <div class="price">${formatMoney(amountMinor, currency)}</div>
    <div class="interval">per ${interval === "month" ? "month" : "year"}</div>
    <div class="row"><span class="label">Billed to</span><span>Test payer</span></div>
    <div class="row"><span class="label">Card</span><span>•••• •••• •••• 4242 (simulated)</span></div>
    <div class="row"><span class="label">Reference</span><span>${escapeHtml(reference)}</span></div>
    <div class="buttons">
      <form method="post" action="/pay/${escapeHtml(reference)}">
        <input type="hidden" name="action" value="success">
        <button class="pay" type="submit">Pay now — ${formatMoney(amountMinor, currency)}</button>
      </form>
      <form method="post" action="/pay/${escapeHtml(reference)}">
        <input type="hidden" name="action" value="fail">
        <button class="fail" type="submit">Cancel / decline payment</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

async function dispatchWebhook({ origin, reference, eventType, amountMinor, currency }) {
  const payload = {
    event_id: `evt_${randomUUID()}`,
    event_type: eventType,
    reference,
    amount_minor: amountMinor,
    currency,
    paid_at: new Date().toISOString(),
  };
  const body = JSON.stringify(payload);
  const signature = signWebhookPayload(body);
  const res = await fetch(`${origin}/api/payments/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": signature },
    body,
  });
  if (!res.ok) {
    throw new Error(`Provider webhook rejected with ${res.status}`);
  }
}

router.get("/:reference", async (req, res) => {
  const session = await prisma.checkoutSession.findUnique({
    where: { reference: req.params.reference },
  });
  if (!session || session.expiresAt < new Date()) {
    return res
      .status(404)
      .send(
        '<h1>This checkout link has expired or is not available.</h1><p><a href="/">Return to the app</a></p>'
      );
  }
  res
    .set("Cache-Control", "no-store")
    .type("html")
    .send(checkoutPage(session));
});

router.post("/:reference", async (req, res) => {
  const action = req.body?.action;
  const session = await prisma.checkoutSession.findUnique({
    where: { reference: req.params.reference },
  });

  const origin = `${req.protocol}://${req.get("host")}`;
  const status = action === "success" ? "success" : "failed";
  try {
    if (action === "success") {
      await dispatchWebhook({
        origin,
        reference: req.params.reference,
        eventType: "payment.captured",
        amountMinor: session ? session.amountMinor : 0,
        currency: session ? session.currency : "USD",
      });
    } else {
      await dispatchWebhook({
        origin,
        reference: req.params.reference,
        eventType: "payment.failed",
        amountMinor: session ? session.amountMinor : 0,
        currency: session ? session.currency : "USD",
      });
    }
    return res.redirect(302, returnUrl(req.params.reference, status));
  } catch (err) {
    console.error("Mock provider failed to dispatch webhook", err);
    return res.redirect(302, returnUrl(req.params.reference, "error"));
  }
});

export default router;