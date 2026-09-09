import { z } from "zod";

// Structured output is defined twice on purpose:
//   1. GeniusJSONSchema is what we *request* from Gemini (responseSchema).
//   2. zodSchema is what we *validate* on receipt in our own code.
// They must stay in sync by hand; the "edit" mirror is small enough to review
// alongside the Zod definition.

export const expenseItemSchema = z.object({
  description: z.string().min(1, "Item description is required."),
  quantity: z.number().int().nonnegative().nullable(),
  unit_price_minor: z.number().int().nonnegative().nullable(),
  line_total_minor: z.number().int().nonnegative().nullable(),
});

export const expenseSummarySchema = z
  .object({
    merchant: z.string().min(1, "Merchant is required."),
    invoice_date: z
      .string()
      .refine((v) => v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), "Use YYYY-MM-DD.")
      .nullable(),
    currency: z.string().length(3).nullable(),
    category: z.string().nullable(),
    payment_method: z.enum(["cash", "card", "mobile", "other"]).nullable(),
    total_minor: z.number().int().nullable(),
    tax_minor: z.number().int().nullable(),
    items: z.array(expenseItemSchema),
    warnings: z.array(z.string()).max(20),
  })
  .strict();

export const expenseSummaryJsonSchema = {
  type: "object",
  propertyOrdering: [
    "merchant",
    "invoice_date",
    "currency",
    "category",
    "payment_method",
    "total_minor",
    "tax_minor",
    "items",
    "warnings",
  ],
  properties: {
    merchant: {
      type: "string",
      description: "Name of the store or restaurant that printed the receipt.",
    },
    invoice_date: {
      type: ["string", "null"],
      description: "Receipt date as YYYY-MM-DD, or null if it cannot be read confidently.",
      format: "date",
    },
    currency: {
      type: ["string", "null"],
      description: "Three-letter ISO 4217 currency code shown on the receipt, or null if unclear.",
    },
    category: {
      type: ["string", "null"],
      description: "Business expense category, e.g. 'Meals & entertainment'. Null if unclear.",
    },
    payment_method: {
      type: ["string", "null"],
      enum: ["cash", "card", "mobile", "other"],
      description: "How the receipt was paid, or null if it does not say.",
    },
    total_minor: {
      type: ["integer", "null"],
      description: "Final total in minor units (cents for USD), or null if it cannot be read confidently.",
    },
    tax_minor: {
      type: ["integer", "null"],
      description: "Tax amount in minor units, or null if none is shown on the receipt.",
    },
    items: {
      type: "array",
      description: "Line items in the order they appear on the receipt. Empty array if none are readable.",
      items: {
        type: "object",
        properties: {
          description: { type: "string", description: "What the line item is." },
          quantity: {
            type: ["integer", "null"],
            description: "Units bought, or null if the receipt does not state a quantity.",
          },
          unit_price_minor: {
            type: ["integer", "null"],
            description: "Price per unit in minor units, or null if unclear.",
          },
          line_total_minor: {
            type: ["integer", "null"],
            description: "Line total in minor units, or null if unclear.",
          },
        },
        required: ["description", "quantity", "unit_price_minor", "line_total_minor"],
      },
    },
    warnings: {
      type: "array",
      items: { type: "string" },
      description:
        "Human-readable notes for each field you had to set to null because the receipt is ambiguous, damaged, or the value is unverifiable.",
    },
  },
  required: [
    "merchant",
    "invoice_date",
    "currency",
    "category",
    "payment_method",
    "total_minor",
    "tax_minor",
    "items",
    "warnings",
  ],
};

export const editResultSchema = z
  .object({
    action: z.enum(["summarise"]),
    summary: z.string().min(1, "Summary is required."),
    bullet_points: z.array(z.string()).max(12),
    word_count: z.number().int().nonnegative(),
  })
  .strict();

export const editResultJsonSchema = {
  type: "object",
  propertyOrdering: ["action", "summary", "bullet_points", "word_count"],
  properties: {
    action: { type: "string", description: "The action that was requested, unchanged." },
    summary: {
      type: "string",
      description: "A plain-language summary of the expense, written for a human colleague.",
    },
    bullet_points: {
      type: "array",
      items: { type: "string" },
      description: "Three to five memorable facts from the expense (what, where, when, amount).",
    },
    word_count: {
      type: "integer",
      description: "Number of words in the summary field, counted exactly.",
    },
  },
  required: ["action", "summary", "bullet_points", "word_count"],
};

export const followUpRequestSchema = z
  .object({
    action: z.enum(["summarise"], { errorMap: () => ({ message: "Unsupported follow-up action." }) }),
  })
  .strict();