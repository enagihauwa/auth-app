import { prisma } from "./src/db.js";
import { runReaper } from "./src/services/reaper.js";
import { priceFor } from "./src/services/billing.js";

async function main() {
  const existing = await prisma.user.findFirst();
  const sub = await prisma.subscription.create({
    data: {
      userId: existing.id,
      status: "active",
      plan: "pro",
      interval: "year",
      amountMinor: priceFor("pro", "year"),
      currency: "USD",
      periodStart: new Date("2026-01-01T00:00:00Z"),
      periodEnd: new Date("2027-01-01T00:00:00Z"),
      pendingInterval: "month",
    },
  });

  await runReaper(new Date("2027-01-02T00:00:00Z"));

  const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
  console.log("downgrade applied at period end:");
  console.log({
    status: after.status,
    interval: after.interval,
    amountMinor: after.amountMinor,
    pendingInterval: after.pendingInterval,
    periodStart: after.periodStart,
    periodEnd: after.periodEnd,
  });

  const evt = await prisma.paymentEvent.findFirst({
    where: { subscriptionId: sub.id, eventType: "interval_change_applied" },
    orderBy: { createdAt: "desc" },
  });
  if (evt) console.log("interval_change_applied:", JSON.stringify(evt.data));

  await prisma.subscription.delete({ where: { id: sub.id } });
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});