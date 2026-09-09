import { z } from "zod";

export const billingIntervalSchema = z.enum(["month", "year"]);

export const checkoutSchema = z.object({
  interval: billingIntervalSchema,
});

export const cancelSchema = z.object({
  reason: z.string().trim().max(200, "Keep the reason under 200 characters.").optional(),
});

export const webhookEventTypes = ["payment.captured", "payment.failed"];