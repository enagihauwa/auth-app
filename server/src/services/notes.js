import { randomUUID } from "node:crypto";

export async function listNotes(db, userId) {
  return db.note.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { publicId: true, title: true, createdAt: true, updatedAt: true },
  });
}

export async function createNote(db, userId, input) {
  return db.note.create({
    data: {
      publicId: randomUUID(),
      title: input.title,
      content: input.content,
      userId,
    },
  });
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
    await tx.note.delete({ where: { id: note.id } });
    status = 200;
  });
  return { status };
}