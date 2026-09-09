import { config } from "../config.js";
import { prisma } from "../db.js";

export const INTERVALS = ["month", "year"];
export const FREE_PLAN = "free";
export const PRO_PLAN = "pro";

export function priceFor(plan = PRO_PLAN, interval) {
  if (plan !== PRO_PLAN) return null;
  return config.pricing.pro[interval];
}

export function addPeriod(from, interval) {
  const date = new Date(from);
  if (interval === "month") {
    date.setMonth(date.getMonth() + 1);
  } else if (interval === "year") {
    date.setFullYear(date.getFullYear() + 1);
  } else {
    throw new Error(`Unknown interval: ${interval}`);
  }
  return date;
}

export async function logPaymentEvent({
  userId,
  subscriptionId = null,
  providerReference,
  providerEventId = null,
  eventType,
  amountMinor,
  currency = config.pricing.currency,
  data = null,
  eventKey = null,
}) {
  return prisma.paymentEvent.create({
    data: {
      userId,
      subscriptionId,
      providerReference,
      providerEventId,
      eventType,
      amountMinor,
      currency,
      data: data == null ? undefined : data,
      eventKey,
    },
  });
}

export async function currentSubscriptionForUser(userId) {
  return prisma.subscription.findUnique({
    where: { userId },
  });
}