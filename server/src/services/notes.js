import { randomUUID } from "node:crypto";
import { recordAudit, AUDIT_ACTIONS } from "./audit.js";

export async function listNotes(db, userId) {
  return db.note.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { publicId: true, title: true, createdAt: true, updatedAt: true },
  });
}

export async function createNote(db, userId, input) {
  const note = await db.note.create({
    data: {
      publicId: randomUUID(),
      title: input.title,
      content: input.content,
      userId,
    },
  });
  await recordAudit(db, {
    action: AUDIT_ACTIONS.NOTE_CREATE,
    actorId: userId,
    targetType: "note",
    targetId: String(note.id),
    detail: "Note created.",
    metadata: { publicId: note.publicId, title: note.title },
  });
  return note;
}

export async function getNote(db, userId, publicId) {
  const note = await db.note.findFirst({
    where: { userId, publicId },
  });
  if (note) return { note };
  return { status: await classifyMissing(db, publicId) };
}

async function classifyMissing(db, publicId) {
  const probe = await db.note.findUnique({
    where: { publicId },
    select: { id: true },
  });
  return probe ? 403 : 404;
}

export async function deleteNote(db, userId, publicId) {
  let status = null;
  await db.$transaction(async (tx) => {
    const note = await tx.note.findFirst({
      where: { userId, publicId },
      select: { id: true, publicId: true, title: true },
    });
    if (!note) {
      status = await classifyMissing(tx, publicId);
      return;
    }
    await tx.noteDeleteAudit.create({
      data: {
        noteId: note.id,
        notePublicId: note.publicId,
        title: note.title,
        deletedBy: userId,
      },
    });
    await recordAudit(tx, {
      action: AUDIT_ACTIONS.NOTE_DELETE,
      actorId: userId,
      targetType: "note",
      targetId: String(note.id),
      detail: "Note deleted.",
      metadata: { publicId: note.publicId, title: note.title },
    });
    await tx.note.delete({ where: { id: note.id } });
    status = 200;
  });
  return { status };
}