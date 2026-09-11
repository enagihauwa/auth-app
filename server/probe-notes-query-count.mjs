import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { prisma } from "./src/db.js";
import {
  listNotes,
  createNote,
  getNote,
  deleteNote,
} from "./src/services/notes.js";

function counting(base) {
  const state = { total: 0, ops: [] };
  const client = base.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        state.total += 1;
        state.ops.push(`${model}.${operation}`);
        return query(args);
      },
    },
  });
  return { client, state };
}

function format(state) {
  const byOp = {};
  for (const op of state.ops) byOp[op] = (byOp[op] ?? 0) + 1;
  const detail = Object.entries(byOp)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, n]) => `${k}${n > 1 ? ` x${n}` : ""}`)
    .join(", ");
  return { total: state.total, detail };
}

/* ---- naive "before" drafts (kept only to measure what the rejected first pass would have cost) ---- */
async function naiveListNotes(db, userId) {
  const all = await db.note.findMany();
  return all.filter((n) => n.userId === userId);
}
async function naiveGetNote(db, userId, publicId) {
  const note = await db.note.findUnique({ where: { publicId } });
  if (!note) return { status: 404 };
  if (note.userId !== userId) return { status: 403 };
  return { note };
}
async function naiveDeleteNote(db, userId, publicId) {
  const note = await db.note.findUnique({ where: { publicId } });
  if (!note) return { status: 404 };
  if (note.userId !== userId) return { status: 403 };
  await db.noteDeleteAudit.create({
    data: {
      noteId: note.id,
      notePublicId: note.publicId,
      title: note.title,
      deletedBy: userId,
    },
  });
  await db.note.delete({ where: { id: note.id } });
  return { status: 200 };
}

/* ---- helpers ---- */
async function freshUser(tag) {
  const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  return prisma.user.create({
    data: {
      name: `QueryCount ${tag}`,
      email: `qc-${tag}-${uniq}@example.test`,
      passwordHash: bcrypt.hashSync("password", 10),
      emailVerifiedAt: new Date(),
    },
  });
}

const owner = await freshUser("owner");
const intruder = await freshUser("intruder");
const seed = await prisma.note.create({
  data: {
    publicId: randomUUID(),
    title: "seed note",
    content: "c",
    userId: owner.id,
  },
});

async function ownNote() {
  return prisma.note.create({
    data: { publicId: randomUUID(), title: "own", content: "c", userId: owner.id },
  });
}

const rows = [];

async function measure(label, beforeFn, afterFn) {
  const b = counting(prisma);
  await beforeFn(b.client);
  const a = counting(prisma);
  await afterFn(a.client);
  rows.push({ label, before: format(b.state), after: format(a.state) });
}

/* list */
await measure(
  "list",
  (c) => naiveListNotes(c, owner.id),
  (c) => listNotes(c, owner.id)
);

/* create */
await measure(
  "create",
  (c) =>
    c.note.create({
      data: { publicId: randomUUID(), title: "c", content: "c", userId: owner.id },
    }),
  (c) => createNote(c, owner.id, { title: "c", content: "c" })
);

/* detail own */
await measure(
  "detail-own",
  (c) => naiveGetNote(c, owner.id, seed.publicId),
  (c) => getNote(c, owner.id, seed.publicId)
);

/* detail other user */
await measure(
  "detail-other-user",
  (c) => naiveGetNote(c, intruder.id, seed.publicId),
  (c) => getNote(c, intruder.id, seed.publicId)
);

/* detail missing */
await measure(
  "detail-missing",
  (c) => naiveGetNote(c, intruder.id, randomUUID()),
  (c) => getNote(c, intruder.id, randomUUID())
);

/* delete own — shipped delete is one $transaction */
{
  const ownBefore = await ownNote();
  const ownAfter = await ownNote();
  await measure(
    "delete-own",
    (c) => naiveDeleteNote(c, owner.id, ownBefore.publicId),
    (c) => deleteNote(c, owner.id, ownAfter.publicId)
  );
}

/* delete other user */
{
  const other = await ownNote();
  await measure(
    "delete-other-user",
    (c) => naiveDeleteNote(c, intruder.id, other.publicId),
    (c) => deleteNote(c, intruder.id, other.publicId)
  );
  await prisma.note.deleteMany({ where: { publicId: other.publicId } });
}

/* delete missing */
await measure(
  "delete-missing",
  (c) => naiveDeleteNote(c, intruder.id, randomUUID()),
  (c) => deleteNote(c, intruder.id, randomUUID())
);

/* ---- output ---- */
console.log("");
console.log("Notes slice: database statements per API action");
console.log("(measured on the live server + real Postgres via a $extends counting client)");
console.log("");
console.log(
  "action           | before (naive: fetch-then-own-check in app code) | after (shipped: ownership in the SQL WHERE)"
);
console.log(
  "-----------------+--------------------------------------------------+----------------------------------------"
);
for (const r of rows) {
  console.log(
    `${r.label.padEnd(16)} | ${String(r.before.total).padStart(2)} statement(s) [${r.before.detail}]`
  );
  console.log(
    `${" ".repeat(17)} | ${" ".repeat(48)} | ${String(r.after.total).padStart(2)} statement(s) [${r.after.detail}]`
  );
}

console.log("");
console.log("Note on the +2 rows (detail/delete of another user or a missing id):");
console.log("  naive fetches the row first, then decides 403/404 in app code — that fetch");
console.log("  returns (for other-user) another person's note over the wire.");
console.log("  shipped keeps the caller's ownership in the SQL WHERE (findFirst), and only");
console.log("  when that finds nothing does one tiny existence probe pick 403 vs 404.");
console.log("");
console.log("List: naive pulls EVERY user's notes into memory then filters in JS; shipped");
console.log("  sends the WHERE userId=… to the database and gets only the caller's rows.");

console.log("");
console.log("=== MACHINE-READABLE ===");
for (const r of rows) {
  console.log(
    `${r.label}\tbefore=${r.before.total}\t[${r.before.detail}]\tafter=${r.after.total}\t[${r.after.detail}]`
  );
}

await prisma.$disconnect();
process.exit(0);
