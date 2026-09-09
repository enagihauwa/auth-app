import { randomUUID } from "node:crypto";
import { Router } from "express";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { checkoutSchema, cancelSchema } from "../../../shared/billing.js";
import { validateBody } from "../validate.js";
import { checkoutLimiter } from "../rateLimit.js";
import {
  INTERVALS,
  priceFor,
  addPeriod,
  logPaymentEvent,
  currentSubscriptionForUser,
} from "../services/billing.js";
import { checkoutUrl, verifyWebhookSignature } from "../billing/provider.js";

const router = Router();

function requireUser(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not signed in." });
  }
  next();
}

function serializeSubscription(sub) {
  if (!sub) return null;
  return {
    status: sub.status,
    plan: sub.plan,
    interval: sub.interval,
    amountMinor: sub.amountMinor,
    currency: sub.currency,
    periodStart: sub.periodStart,
    periodEnd: sub.periodEnd,
    pendingInterval: sub.pendingInterval,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    cancelledAt: sub.cancelledAt,
    cancellationReason: sub.cancellationReason,
  };
}

router.post("/api/billing/checkout", requireUser, checkoutLimiter, validateBody(checkoutSchema), async (req, res) => {
  const userId = req.session.userId;
  const { interval } = req.body;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { plan: true } });
  if (!user) return res.status(401).json({ error: "Not signed in." });

  const sub = await currentSubscriptionForUser(userId);

  if (sub && sub.interval === interval && sub.status === "active") {
    return res.json({ url: null, reference: null, existing: true });
  }

  if (sub && sub.interval === "year" && interval === "month") {
    return res
      .status(409)
      .json({ error: "Downgrades apply at the end of the current period." });
  }

  if (sub && sub.status === "active" && sub.pendingInterval === interval) {
    return res.json({ url: null, reference: null, existing: true });
  }

  const amountMinor = priceFor("pro", interval);

  const openSession = await prisma.checkoutSession.findFirst({
    where: { userId, interval, status: "open", expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (openSession) {
    return res.json({
      url: checkoutUrl(openSession.reference),
      reference: openSession.reference,
      existing: false,
    });
  }

  const reference = `cs_${randomUUID()}`;
  const now = new Date();
  await prisma.checkoutSession.create({
    data: {
      userId,
      reference,
      plan: "pro",
      interval,
      amountMinor,
      currency: config.pricing.currency,
      status: "open",
      expiresAt: new Date(now.getTime() + config.billing.checkoutTtlMs),
    },
  });

  await logPaymentEvent({
    userId,
    providerReference: reference,
    eventType: "checkout_initiated",
    amountMinor,
    data: {
      plan: "pro",
      interval,
    },
    eventKey: `checkout:${reference}`,
  });

  return res.json({ url: checkoutUrl(reference), reference, existing: false, amountMinor });
});

router.get("/api/billing/session/:reference", requireUser, async (req, res) => {
  const session = await prisma.checkoutSession.findFirst({
    where: { reference: req.params.reference, userId: req.session.userId },
    select: {
      reference: true,
      status: true,
      interval: true,
      plan: true,
      amountMinor: true,
      currency: true,
      expiresAt: true,
      completedAt: true,
    },
  });
  if (!session) return res.status(404).json({ error: "That checkout could not be found." });
  return res.json({ session });
});

router.get("/api/billing/summary", requireUser, async (req, res) => {
  const userId = req.session.userId;
  const [user, sub] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { plan: true } }),
    currentSubscriptionForUser(userId),
  ]);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  return res.json({
    user: { plan: user.plan },
    subscription: serializeSubscription(sub),
    pricing: {
      currency: config.pricing.currency,
      pro: { ...config.pricing.pro },
      free: 0,
    },
  });
});

router.post("/api/billing/downgrade", requireUser, async (req, res) => {
  const userId = req.session.userId;
  const sub = await currentSubscriptionForUser(userId);
  if (!sub || sub.status !== "active") {
    return res.status(400).json({ error: "You don't have an active subscription to switch." });
  }
  if (sub.interval !== "year") {
    return res.status(400).json({ error: "Monthly is already the cheapest interval." });
  }
  if (sub.pendingInterval === "month") {
    return res.json({ subscription: serializeSubscription(sub) });
  }

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      pendingInterval: "month",
      updatedAt: new Date(),
    },
  });

  await logPaymentEvent({
    userId,
    subscriptionId: sub.id,
    providerReference: `internal:subscription:${sub.id}`,
    eventType: "downgrade_scheduled",
    amountMinor: 0,
    data: {
      from: sub.interval,
      appliedAt: updated.periodEnd,
    },
  });

  return res.json({ subscription: serializeSubscription(updated) });
});

router.post("/api/billing/cancel", requireUser, validateBody(cancelSchema), async (req, res) => {
  const userId = req.session.userId;
  const reason = req.body.reason || null;

  const sub = await currentSubscriptionForUser(userId);
  if (!sub || sub.status !== "active" || sub.cancelAtPeriodEnd) {
    return res.status(400).json({ error: "There is no active subscription to cancel." });
  }
  if (sub.pendingInterval === "year") {
    return res
      .status(409)
      .json({
        error:
          "You have a paid yearly upgrade scheduled. Cancel is not available until it applies; contact support to undo it.",
      });
  }

  const updated = await prisma.subscription.update({
    where: { id: sub.id },
    data: {
      cancelAtPeriodEnd: true,
      cancelledAt: new Date(),
      cancellationReason: reason,
      updatedAt: new Date(),
    },
  });

  await logPaymentEvent({
    userId,
    subscriptionId: sub.id,
    providerReference: `internal:subscription:${sub.id}`,
    eventType: "cancellation_scheduled",
    amountMinor: 0,
    data: {
      accessUntil: updated.periodEnd,
      reason,
    },
  });

  return res.json({ subscription: serializeSubscription(updated) });
});

router.post(
  "/api/payments/webhook",
  async (req, res) => {
    const rawBody = req.rawBody?.toString() ?? "";
    const signatureHeader = req.headers["x-webhook-signature"];

    if (!verifyWebhookSignature({ rawBody, signatureHeader })) {
      return res.status(401).json({ error: "Invalid webhook signature." });
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ error: "Malformed webhook body." });
    }

    const { event_id: eventId, event_type: eventType, reference } = payload;
    if (!eventId || !eventType || !reference) {
      return res.status(400).json({ error: "Webhook missing required fields." });
    }

    const eventKey = `webhook:${eventId}`;
    const existing = await prisma.paymentEvent.findUnique({ where: { eventKey } });
    if (existing) {
      await logPaymentEvent({
        userId: existing.userId,
        subscriptionId: existing.subscriptionId,
        providerReference: reference,
        providerEventId: eventId,
        eventType: "duplicate_webhook_ignored",
        amountMinor: existing.amountMinor,
        data: {
          reason: "event_id already processed",
          body_event_id: eventId,
          originalEventId: existing.id.toString(),
        },
      });
      return res.json({ ok: true, duplicate: true });
    }

    const session = await prisma.checkoutSession.findUnique({
      where: { reference },
      include: { user: { select: { id: true, plan: true } } },
    });
    if (!session) {
      return res.status(404).json({ error: "Unknown checkout reference." });
    }
    const userId = session.userId;

    if (eventType === "payment.captured") {
      if (session.status !== "open") {
        await logPaymentEvent({
          userId,
          providerReference: reference,
          providerEventId: eventId,
          eventType: "duplicate_webhook_ignored",
          amountMinor: session.amountMinor,
          data: { reason: "checkout already completed" },
        });
        return res.json({ ok: true, duplicate: true });
      }

      await logPaymentEvent({
        userId,
        providerReference: reference,
        providerEventId: eventId,
        eventType: "payment_verified",
        amountMinor: session.amountMinor,
        data: { rawPayload: payload, signature: signatureHeader },
        eventKey,
      });

      await prisma.checkoutSession.update({
        where: { id: session.id },
        data: { status: "completed", completedAt: new Date() },
      });

      await fulfilPayment({
        userId,
        session,
      });

      return res.json({ ok: true });
    }

    if (eventType === "payment.failed") {
      await prisma.checkoutSession.updateMany({
        where: { reference, status: "open" },
        data: { status: "failed" },
      });
      await logPaymentEvent({
        userId,
        providerReference: reference,
        providerEventId: eventId,
        eventType: "payment_failed",
        amountMinor: session.amountMinor,
        data: { rawPayload: payload },
        eventKey,
      });
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Unsupported webhook event type." });
  }
);

async function fulfilPayment({ userId, session }) {
  const now = new Date();
  const sub = await currentSubscriptionForUser(userId);

  if (sub && sub.interval === "month" && session.interval === "year") {
    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        pendingInterval: "year",
        cancelAtPeriodEnd: false,
        cancelledAt: null,
        cancellationReason: null,
        status: "active",
        updatedAt: now,
      },
    });

    await logPaymentEvent({
      userId,
      subscriptionId: sub.id,
      providerReference: session.reference,
      eventType: "upgrade_scheduled",
      amountMinor: session.amountMinor,
      data: {
        from: "month",
        to: "year",
        appliedAt: sub.periodEnd,
      },
    });

    await logPaymentEvent({
      userId,
      subscriptionId: sub.id,
      providerReference: session.reference,
      eventType: "subscription_fulfilled",
      amountMinor: session.amountMinor,
      data: {
        plan: "pro",
        interval: "year",
        upgrade: true,
        scheduled: true,
        startsAt: sub.periodEnd,
      },
    });

    await prisma.user.update({ where: { id: userId }, data: { plan: "pro", updatedAt: now } });
    return;
  }

  const periodStart = now;
  const periodEnd = addPeriod(now, session.interval);
  await prisma.subscription.upsert({
    where: { userId },
    update: {
      status: "active",
      plan: "pro",
      interval: session.interval,
      amountMinor: priceFor("pro", session.interval),
      periodStart,
      periodEnd,
      pendingInterval: null,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      cancellationReason: null,
      updatedAt: now,
    },
    create: {
      userId,
      status: "active",
      plan: "pro",
      interval: session.interval,
      amountMinor: priceFor("pro", session.interval),
      periodStart,
      periodEnd,
      currency: config.pricing.currency,
    },
  });

  await prisma.user.update({ where: { id: userId }, data: { plan: "pro", updatedAt: now } });

  const subRow = await currentSubscriptionForUser(userId);
  await logPaymentEvent({
    userId,
    subscriptionId: subRow.id,
    providerReference: session.reference,
    eventType: "subscription_fulfilled",
    amountMinor: session.amountMinor,
    data: { plan: "pro", interval: session.interval, periodStart, periodEnd, upgrade: false },
  });
}

export default router;