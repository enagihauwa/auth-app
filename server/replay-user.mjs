import { randomUUID } from "node:crypto";
import { prisma } from "./src/db.js";
import { signWebhookPayload } from "./src/billing/provider.js";

const BASE = process.env.BASE || "http://localhost:3000";
const EMAIL = process.env.EMAIL || "freecheck_1788811402826@test.local";
const PASSWORD = process.env.PASSWORD || "Passw0rd!x";

async function fetchRetry(path, opts) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(`${BASE}${path}`, { ...opts, keepalive: false });
    } catch (err) {
      if (attempt >= 4) throw err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

async function req(path, { method = "GET", body, cookie } = {}) {
  const opts = { method, headers: { "content-type": "application/json" }, redirect: "manual" };
  if (cookie) opts.headers.cookie = cookie;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetchRetry(path, opts);
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, setCookie };
}
const getCookie = (sc) => (sc ? sc.split(";")[0] : "");

(async () => {
  const user = await prisma.user.findFirst({ where: { email: EMAIL } });
  console.log("USER ID :", user.id);
  console.log("EMAIL   :", user.email, `(current plan: ${user.plan})`);

  const si = await req("/api/auth/signin", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
  console.log("signin  :", si.status, JSON.stringify(si.data));
  if (si.status !== 200) process.exit(1);
  const cookie = getCookie(si.setCookie);

  const ck = await req("/api/billing/checkout", { method: "POST", body: { interval: "month" }, cookie });
  console.log("checkout:", ck.status, "reference:", ck.data.reference, "amountMinor:", ck.data.amountMinor);

  const payload = JSON.stringify({
    event_id: `evt_${randomUUID()}`,
    event_type: "payment.captured",
    reference: ck.data.reference,
    amount_minor: ck.data.amountMinor,
    currency: "USD",
    paid_at: new Date().toISOString(),
  });
  const signature = signWebhookPayload(payload);

  console.log("\n=== DELIVERY 1 (real payment.captured) ===");
  const d1 = await fetchRetry("/api/payments/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": signature },
    body: payload,
  });
  console.log("HTTP", d1.status, JSON.stringify(await d1.json()));
  await new Promise((r) => setTimeout(r, 300));

  console.log("\n=== DELIVERY 2 (byte-identical request) ===");
  const d2 = await fetchRetry("/api/payments/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": signature },
    body: payload,
  });
  console.log("HTTP", d2.status, JSON.stringify(await d2.json()));
  await new Promise((r) => setTimeout(r, 300));

  console.log("\n=== DELIVERY 3 (same event_id, re-signed) ===");
  const d3 = await fetchRetry("/api/payments/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": signWebhookPayload(payload) },
    body: payload,
  });
  console.log("HTTP", d3.status, JSON.stringify(await d3.json()));
  await new Promise((r) => setTimeout(r, 300));

  console.log("\n=== LEDGER for this user (look up USER ID " + user.id + " in Prisma Studio) ===");
  const events = await prisma.paymentEvent.findMany({
    where: { userId: user.id }, orderBy: { createdAt: "asc" },
  });
  console.table(
    events.map((e) => ({
      event_type: e.eventType,
      event_key: e.eventKey,
      amount_minor: e.amountMinor,
      data: JSON.stringify(e.data),
      created_at: e.createdAt.toISOString(),
    }))
  );
  const dupes = events.filter((e) => e.eventType === "duplicate_webhook_ignored");
  const verified = events.filter((e) => e.eventType === "payment_verified");
  const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
  console.log("payment_verified rows:", verified.length, "| duplicate_webhook_ignored rows:", dupes.length);
  console.log("subscription after replays:", sub ? `${sub.plan}/${sub.interval} ${sub.amountMinor} status=${sub.status}` : "none");
  console.log("\nIn Prisma Studio, filter PaymentEvent by user_id = " + user.id);

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });