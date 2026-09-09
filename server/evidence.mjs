import { prisma } from "./src/db.js";

const EMAIL = process.env.E2E_EMAIL;

async function main() {
  const user = await prisma.user.findFirst({ where: { email: EMAIL } });
  if (!user) {
    console.error("No such user: " + EMAIL);
    process.exit(1);
  }

  const sub = await prisma.subscription.findUnique({ where: { userId: user.id } });
  const events = await prisma.paymentEvent.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  const sessions = await prisma.checkoutSession.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
  });
  const dupes = events.filter((e) => e.eventType === "duplicate_webhook_ignored");

  console.log("=== USERS ===");
  console.table([
    { id: user.id, email: user.email, plan: user.plan, created_at: user.createdAt.toISOString() },
  ]);

  console.log("\n=== SUBSCRIPTIONS ===");
  if (sub) {
    console.table([
      {
        user_id: sub.userId,
        status: sub.status,
        plan: sub.plan,
        interval: sub.interval,
        amount_minor: sub.amountMinor,
        currency: sub.currency,
        period_start: sub.periodStart.toISOString(),
        period_end: sub.periodEnd.toISOString(),
        pending_interval: sub.pendingInterval,
        cancel_at_period_end: sub.cancelAtPeriodEnd,
        cancellation_reason: sub.cancellationReason,
      },
    ]);
  } else {
    console.log("(no subscription row)");
  }

  console.log("\n=== CHECKOUT_SESSIONS ===");
  console.table(
    sessions.map((s) => ({
      reference: s.reference,
      plan: s.plan,
      interval: s.interval,
      amount_minor: s.amountMinor,
      currency: s.currency,
      status: s.status,
      expires_at: s.expiresAt.toISOString(),
      completed_at: s.completedAt?.toISOString() ?? null,
    }))
  );

  console.log("\n=== PAYMENT_EVENTS (chronological) ===");
  console.table(
    events.map((e) => ({
      id: e.id.toString(),
      event_type: e.eventType,
      amount_minor: e.amountMinor,
      event_key: e.eventKey,
      sub_id: e.subscriptionId ?? null,
      data: JSON.stringify(e.data),
      created_at: e.createdAt.toISOString(),
    }))
  );

  // Proof: the monthly->yearly upgrade is charged now and applied at period end
  console.log("\n=== PROOF: SCHEDULED YEARLY UPGRADE (monthly $10.00 -> yearly $100.00) ===");
  const verified = events.filter((e) => e.eventType === "payment_verified");
  const upgradeScheduled = events.find((e) => e.eventType === "upgrade_scheduled");
  const intervalChanged = events.find((e) => e.eventType === "interval_change_applied");
  if (upgradeScheduled && intervalChanged) {
    console.log(`upgrade charge captured now     : ${upgradeScheduled.amountMinor} (payment_verified row shows ${verified[verified.length - 1]?.amountMinor})`);
    console.log(`upgrade_scheduled               : applies at ${upgradeScheduled.data.appliedAt}`);
    console.log(`interval_change_applied         : ${intervalChanged.data.from} -> ${intervalChanged.data.to} at ${intervalChanged.data.appliedAt}`);
    console.log(`final subscription              : ${intervalChanged.data.to}/${sub.plan} @ ${sub.amountMinor}`);
  }

  console.log("\n=== PROOF: WEBHOOK IDEMPOTENCY (same event_id replayed) ===");
  console.log(`duplicate_webhook_ignored rows  : ${dupes.length}`);
  console.log(`plan still intact               : ${user.plan} (${user.email})`);

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});