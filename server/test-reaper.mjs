import { prisma } from "./src/db.js";
import { runReaper } from "./src/services/reaper.js";

const EMAIL = process.env.E2E_EMAIL;
if (!EMAIL) {
  console.error("Missing E2E_EMAIL");
  process.exit(1);
}

async function main() {
  const user = await prisma.user.findFirst({ where: { email: EMAIL } });
  let sub = await prisma.subscription.findUnique({ where: { userId: user.id } });

  console.log("before reaper:");
  console.log({
    status: sub.status,
    interval: sub.interval,
    pendingInterval: sub.pendingInterval,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    periodEnd: sub.periodEnd,
    plan: (await prisma.user.findUnique({ where: { id: user.id } })).plan,
  });

  // Simulate reaching the end of the billing period.
  await prisma.subscription.update({
    where: { id: sub.id },
    data: { periodEnd: new Date(Date.now() - 1000) },
  });

  const now = new Date();
  await runReaper(now);

  sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
  const finalUser = await prisma.user.findUnique({ where: { id: user.id } });

  console.log("\nafter reaper (cancel_at_period_end=true):");
  console.log({
    status: sub.status,
    interval: sub.interval,
    pendingInterval: sub.pendingInterval,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    plan: finalUser.plan,
  });

  const ended = await prisma.paymentEvent.findMany({
    where: { userId: user.id, eventType: { in: ["subscription_ended", "interval_change_applied"] } },
    orderBy: { createdAt: "asc" },
  });
  for (const e of ended) console.log(`- ${e.eventType} | data=${JSON.stringify(e.data)}`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});