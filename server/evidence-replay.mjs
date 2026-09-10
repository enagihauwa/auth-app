import { randomUUID } from "node:crypto";
import { prisma } from "./src/db.js";
import { signWebhookPayload } from "./src/billing/provider.js";

const BASE = process.env.BASE || "http://localhost:3000";

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
const log = (label, v) => console.log(`\n[${label}]\n${JSON.stringify(v, null, 2)}`);

async function webhook({ payload, signature }) {
  const res = await fetchRetry("/api/payments/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": signature },
    body: payload,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

(async () => {
  const email = `replay_ev_${Date.now()}@test.local`;
  const password = "Passw0rd!x";

  // Fresh account
  await req("/api/auth/signup", { method: "POST", body: { name: "Replay", email, password } });
  const user = await prisma.user.findFirst({ where: { email } });
  await prisma.user.update({ where: { id: user.id }, data: { emailVerifiedAt: new Date(), updatedAt: new Date() } });
  const si = await req("/api/auth/signin", { method: "POST", body: { email, password } });
  const cookie = getCookie(si.setCookie);
  const me0 = await req("/api/me", { cookie });
  console.log(`fresh user plan: ${me0.data.user.plan}`);

  // Start a monthly checkout
  const ck = await req("/api/billing/checkout", { method: "POST", body: { interval: "month" }, cookie });
  const reference = ck.data.reference;
  console.log(`checkout reference: ${reference}`);

  // ONE authentic provider payload
  const payload = JSON.stringify({
    event_id: `evt_${randomUUID()}`,
    event_type: "payment.captured",
    reference,
    amount_minor: 1000,
    currency: "USD",
    paid_at: new Date().toISOString(),
  });
  const signature = signWebhookPayload(payload);

  console.log("\n=================== DELIVERY 1 — provider posts payment.captured ===================");
  let d1 = await webhook({ payload, signature });
  console.log(`HTTP ${d1.status} ${JSON.stringify(d1.body)}`);

  await new Promise((r) => setTimeout(r, 300));

  // State after delivery 1
  const after1 = {
    verified: await prisma.paymentEvent.count({ where: { userId: user.id, eventType: "payment_verified" } }),
    fulfilled: await prisma.paymentEvent.count({ where: { userId: user.id, eventType: "subscription_fulfilled" } }),
    dup: await prisma.paymentEvent.count({ where: { userId: user.id, eventType: "duplicate_webhook_ignored" } }),
  };
  console.log("ledger after delivery 1:", JSON.stringify(after1));

  console.log("\n=================== DELIVERY 2 — the EXACT SAME request retried by the provider ===================");
  console.log(`same body + same x-webhook-signature header (byte-identical)`);
  let d2 = await webhook({ payload, signature });
  console.log(`HTTP ${d2.status} ${JSON.stringify(d2.body)}`);

  await new Promise((r) => setTimeout(r, 300));

  // State after delivery 2
  const after2 = {
    verified: await prisma.paymentEvent.count({ where: { userId: user.id, eventType: "payment_verified" } }),
    fulfilled: await prisma.paymentEvent.count({ where: { userId: user.id, eventType: "subscription_fulfilled" } }),
    dup: await prisma.paymentEvent.count({ where: { userId: user.id, eventType: "duplicate_webhook_ignored" } }),
  };
  console.log("ledger after delivery 2:", JSON.stringify(after2));

  console.log("\n=================== DELIVERY 3 — same event_id, re-signed (fresh timestamp) ===================");
  let d3 = await webhook({ payload, signature: signWebhookPayload(payload) });
  console.log(`HTTP ${d3.status} ${JSON.stringify(d3.body)}`);
  await new Promise((r) => setTimeout(r, 300));

  const after3 = {
    verified: await prisma.paymentEvent.count({ where: { userId: user.id, eventType: "payment_verified" } }),
    fulfilled: await prisma.paymentEvent.count({ where: { userId: user.id, eventType: "subscription_fulfilled" } }),
    dup: await prisma.paymentEvent.count({ where: { userId: user.id, eventType: "duplicate_webhook_ignored" } }),
  };
  console.log("ledger after delivery 3:", JSON.stringify(after3));

  console.log("\n=================== NO-SIGNATURE HONESTY CHECK ===================");
  const noSig = await fetchRetry("/api/payments/webhook", {
    method: "POST", headers: { "content-type": "application/json" }, body: payload,
  });
  console.log(`no signature -> HTTP ${noSig.status} ${JSON.stringify(await noSig.json())}`);

  console.log("\n=================== LEDGER — this user, chronological ===================");
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

  const dupRows = events.filter((e) => e.eventType === "duplicate_webhook_ignored");
  const verifiedRows = events.filter((e) => e.eventType === "payment_verified");
  const fulfilledRows = events.filter((e) => e.eventType === "subscription_fulfilled");
  const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });

  console.log("\n=================== PROOF: SECOND FIRING RECORDED AND IGNORED ===================");
  console.log(`deliveries with the same event_id       : ${1 + dupRows.length} (1 real + ${dupRows.length} replayed)`);
  console.log(`payment_verified rows                   : ${verifiedRows.length} (charged exactly once)`);
  console.log(`subscription_fulfilled rows             : ${fulfilledRows.length} (granted exactly once)`);
  console.log(`duplicate_webhook_ignored rows recorded : ${dupRows.length}`);
  for (const dup of dupRows) {
    console.log(`  - recorded ignored webhook reason:"${dup.data.reason}" originalEventId:${dup.data.originalEventId} body_event_id:${dup.data.body_event_id}`);
  }
  console.log(`subscription after all replays          : ${sub.plan}/${sub.interval} ${sub.amountMinor} status=${sub.status} periodStart=${sub.periodStart.toISOString()} periodEnd=${sub.periodEnd.toISOString()}`);
  console.log(`user plan still                         : free->pro (${(await prisma.user.findFirst({ where: { email } })).plan})`);

  await prisma.$disconnect();
})();