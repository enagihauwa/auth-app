import { Router } from "express";
import { prisma } from "../db.js";
import { validateBody } from "../validate.js";
import { createNoteSchema, notePublicIdSchema } from "../../../shared/notes.js";
import {
  listNotes,
  createNote,
  getNote,
  deleteNote,
} from "../services/notes.js";

const router = Router();

function requireUser(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not signed in." });
  }
  next();
}

function serializeNote(note, { includeContent = true } = {}) {
  const base = {
    public_id: note.publicId,
    title: note.title,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
  };
  if (includeContent) base.content = note.content;
  return base;
}

router.get("/", requireUser, async (req, res, next) => {
  try {
    const notes = await listNotes(prisma, req.session.userId);
    res.json({ notes });
  } catch (err) {
    next(err);
  }
});

router.post("/", requireUser, validateBody(createNoteSchema), async (req, res, next) => {
  try {
    const note = await createNote(prisma, req.session.userId, req.body);
    res.status(201).json({ note: serializeNote(note) });
  } catch (err) {
    next(err);
  }
});

router.get("/:publicId", requireUser, async (req, res, next) => {
  try {
    const parsed = notePublicIdSchema.safeParse(req.params.publicId);
    if (!parsed.success) {
      return res.status(400).json({ error: "That is not a note id." });
    }
    const result = await getNote(prisma, req.session.userId, parsed.data);
    if (result.status === 403) {
      return res.status(403).json({ error: "You don't have access to that note." });
    }
    if (result.status === 404) {
      return res.status(404).json({ error: "Note not found." });
    }
    res.json({ note: serializeNote(result.note) });
  } catch (err) {
    next(err);
  }
});

router.delete("/:publicId", requireUser, async (req, res, next) => {
  try {
    const parsed = notePublicIdSchema.safeParse(req.params.publicId);
    if (!parsed.success) {
      return res.status(400).json({ error: "That is not a note id." });
    }
    const { status } = await deleteNote(prisma, req.session.userId, parsed.data);
    if (status === 403) {
      return res.status(403).json({ error: "You don't have access to that note." });
    }
    if (status === 404) {
      return res.status(404).json({ error: "Note not found." });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;