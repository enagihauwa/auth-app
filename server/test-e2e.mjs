import { prisma } from "./src/db.js";

const BASE = process.env.BASE || "http://localhost:3100";

async function req(path, { method = "GET", body, cookie } = {}) {
  const opts = {
    method,
    headers: { "content-type": "application/json" },
    redirect: "manual",
  };
  if (cookie) opts.headers.cookie = cookie;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, setCookie };
}

function getCookie(sc) { return sc ? sc.split(";")[0] : ""; }
function log(label, v) { console.log(`\n[${label}]\n${JSON.stringify(v, null, 2)}`); }

(async () => {
  const email = `e2e_billing_${Date.now()}@test.local`;
  const password = "Passw0rd!x";

  // Signup
  const su = await req("/api/auth/signup", { method: "POST", body: { name: "E2E", email, password } });
  log("signup", { status: su.status, data: su.data });

  // Verify directly in DB (avoids Mailpit dependency)
  const user = await prisma.user.findFirst({ where: { email } });
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), updatedAt: new Date() } });
  console.log("email verified directly via DB");

  // Signin
  const si = await req("/api/auth/signin", { method: "POST", body: { email, password } });
  log("signin", { status: si.status, data: si.data });
  const cookie = getCookie(si.setCookie);

  // Confirm free plan
  const me0 = await req("/api/me", { cookie });
  log("me(free)", { plan: me0.data.user.plan });

  // 1. Monthly subscribe
  const ck = await req("/api/billing/checkout", { method: "POST", body: { interval: "month" }, cookie });
  log("checkout-month", { ref: ck.data.reference, existing: ck.data.existing, url: ck.data.url });
  const monthlyRef = ck.data.reference;

  const payRes = await fetch(`${BASE}/pay/${monthlyRef}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "action=success",
    redirect: "manual",
  });
  log("mock-pay-month", { status: payRes.status, location: payRes.headers.get("location") });
  await new Promise(r => setTimeout(r, 600));

  const me1 = await req("/api/me", { cookie });
  log("me(pro-monthly)", { plan: me1.data.user.plan });
  const sum0 = await req("/api/billing/summary", { cookie });
  log("summary(monthly)", { interval: sum0.data.subscription?.interval, price: sum0.data.subscription?.amountMinor });

  // 2. Schedule monthly -> yearly upgrade (charged now, starts at period end)
  const ck2 = await req("/api/billing/checkout", { method: "POST", body: { interval: "year" }, cookie });
  log("checkout-year-upgrade", { ref: ck2.data.reference, amount: ck2.data.amountMinor, existing: ck2.data.existing });
  const yearlyRef = ck2.data.reference;

  const payRes2 = await fetch(`${BASE}/pay/${yearlyRef}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "action=success",
    redirect: "manual",
  });
  await new Promise(r => setTimeout(r, 600));

  // Upgrade must be pending, not applied: still monthly at the monthly price
  const sum1 = await req("/api/billing/summary", { cookie });
  log("summary(upgrade-scheduled)", {
    interval: sum1.data.subscription?.interval,
    price: sum1.data.subscription?.amountMinor,
    pendingInterval: sum1.data.subscription?.pendingInterval,
  });

  // 3. Drive the reaper across the current month's end -> upgrade applies
  const { runReaper } = await import("./src/services/reaper.js");
  await prisma.subscription.update({
    where: { userId: user.id },
    data: { periodEnd: new Date(Date.now() - 1000), updatedAt: new Date() },
  });
  await runReaper(new Date());
  const sum2 = await req("/api/billing/summary", { cookie });
  log("summary(month-end-applied)", {
    interval: sum2.data.subscription?.interval,
    price: sum2.data.subscription?.amountMinor,
    pendingInterval: sum2.data.subscription?.pendingInterval,
    periodStart: sum2.data.subscription?.periodStart,
    periodEnd: sum2.data.subscription?.periodEnd,
  });

  // 4. Schedule downgrade year -> month
  const dg = await req("/api/billing/downgrade", { method: "POST", body: {}, cookie });
  log("downgrade-scheduled", { pendingInterval: dg.data.subscription?.pendingInterval });

  // 5. Cancel with reason
  const ca = await req("/api/billing/cancel", { method: "POST", body: { reason: "too_expensive" }, cookie });
  log("cancel", {
    cancelAtPeriodEnd: ca.data.subscription?.cancelAtPeriodEnd,
    reason: ca.data.subscription?.cancellationReason,
  });

  // 6. Re-fire webhook (duplicate proof) — raw replay
  const { signWebhookPayload } = await import("./src/billing/provider.js");
  const payload = JSON.stringify({
    event_id: `evt_replay_${Date.now()}`,
    event_type: "payment.captured",
    reference: yearlyRef,
    amount_minor: 10000,
    currency: "USD",
  });
  const sig = signWebhookPayload(payload);
  const r1 = await fetch(`${BASE}/api/payments/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": sig },
    body: payload,
  });
  log("webhook-replay-1", { status: r1.status, body: await r1.json() });

  // Same event_id again
  const r2 = await fetch(`${BASE}/api/payments/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": sig },
    body: payload,
  });
  log("webhook-replay-2-duplicate", { status: r2.status, body: await r2.json() });

  // Final state
  const meFinal = await req("/api/me", { cookie });
  log("me-final", { plan: meFinal.data.user.plan });
  const sumFinal = await req("/api/billing/summary", { cookie });
  log("summary-final", {
    interval: sumFinal.data.subscription?.interval,
    status: sumFinal.data.subscription?.status,
    cancelAtPeriodEnd: sumFinal.data.subscription?.cancelAtPeriodEnd,
    cancellationReason: sumFinal.data.subscription?.cancellationReason,
  });

  // Event log
  const allEvents = await prisma.paymentEvent.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  log("payment_events", allEvents.map(e => ({
    type: e.eventType,
    amount: e.amountMinor,
    key: e.eventKey,
  })));

  console.log("\n=== E2E COMPLETE ===");
  console.log("EMAIL=" + email);
  await prisma.$disconnect();
})().catch(err => { console.error("E2E FAILED", err); process.exit(1); });