// Two roles, one model (config.processing.modelId, default gemini-2.5-flash):
//   extract — vision model turns receipt images into structured expense data.
//   edit    — text model turns that structured data into a human summary (follow-up action).
// Every parameter set below is justified in one line in `paramJustification`.

import {
  expenseSummarySchema,
  expenseSummaryJsonSchema,
  editResultSchema,
  editResultJsonSchema,
} from "./schemas.js";

export const ROLES = {
  extract: {
    id: "extract",
    systemPrompt:
      "You are a meticulous receipt-extraction clerk. The user sends one or more receipt " +
      "images (occasionally a PDF of a receipt). Read every visible number and label. Populate " +
      "the output schema exactly as specified. Rules: (1) Never invent a value — if a field " +
      "cannot be read confidently, set it to null and explain why in `warnings` as concise " +
      "human-readable notes. (2) `total_minor`, `tax_minor`, `unit_price_minor` and " +
      "`line_total_minor` are integer minor units (e.g. $12.34 is 1234); do not round or " +
      "estimate. (3) `invoice_date` is ISO YYYY-MM-DD. (4) `currency` is the three-letter ISO " +
      "4217 code printed on the receipt. (5) `merchant` is the official name on the receipt, " +
      "not your guess of the brand. (6) Keep line item ordering identical to the printed " +
      "receipt. (7) If the image is not a receipt at all, set `merchant` to what the document " +
      "is, `total_minor` to null, and add a warning.",
    params: {
      temperature: 0,
      topP: 1,
      maxOutputTokens: 2048,
    },
    paramJustification: {
      temperature:
        "Zero temperature keeps extraction reproducible — receipts are facts to transcribe, not prose to generate.",
      topP:
        "topP=1 disables nucleus sampling entirely so temperature (already 0) is the only sampling influence.",
      maxOutputTokens:
        "2048 comfortably holds a long line-itemised receipt while capping output cost per run.",
    },
    schema: {
      zod: expenseSummarySchema,
      json: expenseSummaryJsonSchema,
    },
  },

  edit: {
    id: "edit",
    systemPrompt:
      "You are an expense-memo editor working from already-extracted structured data. The " +
      "user sends: (1) the extracted expense summary as JSON, and (2) the requested action, " +
      "always `summarise`. Produce the output schema exactly: `action` must echo the requested " +
      "action unchanged; `summary` is a plain-language memo of five to nine sentences aimed at a " +
      "colleague who will reimburse the expense — mention what was bought, where, roughly when, " +
      "the amount in the receipt's own currency (use major units, e.g. €12.34), and anything " +
      "notable from `warnings`; `bullet_points` is three to five short facts; `word_count` is the " +
      "exact number of words in `summary` (count hyphenated words as one, numbers as one). Never " +
      "invent facts not present in the provided JSON; where the JSON field is null, say so " +
      "instead of guessing.",
    params: {
      temperature: 0.4,
      topP: 0.95,
      maxOutputTokens: 1024,
    },
    paramJustification: {
      temperature:
        "0.4 allows natural variations of wording for the plain-language memo while keeping the extractable facts verbatim.",
      topP:
        "0.95 keeps nucleus sampling at its documented default so temperature alone is the tuned creative knob.",
      maxOutputTokens:
        "1024 caps the memo and bullet points while ample margin over the typical ~200-token output, bounding cost.",
    },
    schema: {
      zod: editResultSchema,
      json: editResultJsonSchema,
    },
  },
};

export { expenseSummarySchema, expenseSummaryJsonSchema, editResultSchema, editResultJsonSchema };