import { prisma } from "./src/db.js";
import { signWebhookPayload } from "./src/billing/provider.js";

const BASE = process.env.BASE || "http://localhost:3100";
const EMAIL = process.env.E2E_EMAIL;
if (!EMAIL) {
  console.error("Missing E2E_EMAIL");
  process.exit(1);
}

async function main() {
  const user = await prisma.user.findFirst({ where: { email: EMAIL } });

  // The real captured webhook for the scheduled yearly upgrade.
  const verified = await prisma.paymentEvent.findFirst({
    where: { userId: user.id, eventType: "payment_verified" },
    orderBy: { createdAt: "desc" },
  });
  const raw = verified.data.rawPayload;

  console.log("Original captured webhook event_id:", raw.event_id);
  console.log("(event logged already under key webhook:" + raw.event_id + ")");

  // Re-sign the SAME event payload with a fresh timestamp so signature verifies.
  const payload = JSON.stringify(raw);
  const sig = signWebhookPayload(payload);

  console.log("\n=== REPLAY 1: same event_id, fresh valid signature ===");
  const r1 = await fetch(`${BASE}/api/payments/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": sig },
    body: payload,
  });
  console.log(r1.status, JSON.stringify(await r1.json()));

  console.log("\n=== REPLAY 2: same event_id again ===");
  const r2 = await fetch(`${BASE}/api/payments/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-webhook-signature": sig },
    body: payload,
  });
  console.log(r2.status, JSON.stringify(await r2.json()));

  const ignored = await prisma.paymentEvent.findMany({
    where: { userId: user.id, eventType: "duplicate_webhook_ignored" },
    orderBy: { createdAt: "asc" },
  });
  console.log("\n=== duplicate_webhook_ignored rows ===");
  for (const e of ignored) console.log(`- ${e.eventType} | data=${JSON.stringify(e.data)} | amount=${e.amountMinor}`);

  console.log("\n=== forgot-signature honesty check (should 401) ===");
  const bad = await fetch(`${BASE}/api/payments/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  console.log(bad.status, JSON.stringify(await bad.json()));

  const plan = (await prisma.user.findFirst({ where: { email: EMAIL } })).plan;
  console.log("\nplan after replays:", plan);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});