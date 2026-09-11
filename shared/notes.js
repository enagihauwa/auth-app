import { z } from "zod";

// The only note identifier that ever reaches the outside world is a random UUID
// (public_id). It is validated strictly everywhere so a malformed value never
// becomes a 500 or a raw database lookup.
export const notePublicIdSchema = z.string().uuid("That does not look like a note id.");

export const createNoteSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, "Title is required.")
    .max(120, "Titles are capped at 120 characters."),
  content: z
    .string()
    .trim()
    .min(1, "Write something first.")
    .max(20000, "Notes are capped at 20,000 characters."),
});