import { prisma } from "../db.js";
import { addPeriod, priceFor, logPaymentEvent } from "./billing.js";

export const REAPER_INTERVAL_MS = 60_000;

export async function runReaper(now = new Date()) {
  const due = await prisma.subscription.findMany({
    where: { status: "active", periodEnd: { lte: now } },
  });

  for (const sub of due) {
    if (sub.cancelAtPeriodEnd) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: "cancelled", plan: "free", updatedAt: now },
      });
      await prisma.user.update({
        where: { id: sub.userId },
        data: { plan: "free", updatedAt: now },
      });
      await logPaymentEvent({
        userId: sub.userId,
        subscriptionId: sub.id,
        providerReference: `internal:subscription:${sub.id}`,
        eventType: "subscription_ended",
        amountMinor: 0,
        data: { reason: "cancel_at_period_end", accessEndedAt: now },
      });
    } else if (sub.pendingInterval) {
      const target = sub.pendingInterval;
      const periodStart = now;
      const periodEnd = addPeriod(now, target);
      await prisma.subscription.update({
        where: { id: sub.id },
        data: {
          interval: target,
          amountMinor: priceFor("pro", target),
          periodStart,
          periodEnd,
          pendingInterval: null,
          updatedAt: now,
        },
      });
      await logPaymentEvent({
        userId: sub.userId,
        subscriptionId: sub.id,
        providerReference: `internal:subscription:${sub.id}`,
        eventType: "interval_change_applied",
        amountMinor: priceFor("pro", target),
        data: { from: sub.interval, to: target, appliedAt: now },
      });
    }
    // Active subscriber, no pending change, no cancellation: in test mode the
    // period simply rolls on when the next payment is captured.
  }

  const overdue = await prisma.checkoutSession.findMany({
    where: { status: "open", expiresAt: { lte: now } },
  });
  for (const session of overdue) {
    await prisma.checkoutSession.update({
      where: { id: session.id },
      data: { status: "expired" },
    });
    await logPaymentEvent({
      userId: session.userId,
      providerReference: session.reference,
      eventType: "checkout_expired",
      amountMinor: session.amountMinor,
      data: { expiresAt: session.expiresAt },
    });
  }
}

export function startReaper() {
  runReaper().catch((err) => console.error("Reaper run failed", err));
  const handle = setInterval(() => {
    runReaper().catch((err) => console.error("Reaper run failed", err));
  }, REAPER_INTERVAL_MS);
  handle.unref?.();
  return handle;
}