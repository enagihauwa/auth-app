import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { prisma } from "./src/db.js";
import app from "./src/app.js";

const PORT = 4001;
const base = `http://127.0.0.1:${PORT}`;

const server = app.listen(PORT);
after(async () => {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function freshUser() {
  const n = Date.now() + Math.floor(Math.random() * 1e9);
  return prisma.user.create({
    data: {
      name: `Notes Tester ${n}`,
      email: `notes-${n}@example.test`,
      passwordHash: bcrypt.hashSync("password", 10),
      emailVerifiedAt: new Date(),
    },
  });
}

async function sessionCookieFor(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const res = await fetch(`${base}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: "password" }),
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie");
  assert.ok(setCookie, "signin should set a session cookie");
  return setCookie.split(";")[0];
}

function authHeaders(cookie) {
  return { cookie, "Content-Type": "application/json" };
}

function publicIds(notes) {
  return notes.map((n) => n.public_id);
}

before(async () => {
  await prisma.$connect();
});

test("notes require a session on every route", async () => {
  const anonCreate = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "X", content: "Y" }),
    redirect: "manual",
  });
  assert.equal(anonCreate.status, 401);

  const anonList = await fetch(`${base}/api/notes`, { redirect: "manual" });
  assert.equal(anonList.status, 401);

  const anonDetail = await fetch(`${base}/api/notes/${randomUUID()}`, { redirect: "manual" });
  assert.equal(anonDetail.status, 401);

  const anonDelete = await fetch(`${base}/api/notes/${randomUUID()}`, { method: "DELETE", redirect: "manual" });
  assert.equal(anonDelete.status, 401);
});

test("creation validates input and returns the public identifier", async () => {
  const user = await freshUser();
  const sid = await sessionCookieFor(user.id);

  const empty = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: authHeaders(sid),
    body: JSON.stringify({ title: "", content: "" }),
    redirect: "manual",
  });
  assert.equal(empty.status, 400);

  const res = await fetch(`${base}/api/notes`, {
    method: "POST",
    headers: authHeaders(sid),
    body: JSON.stringify({ title: "Shopping list", content: "Milk and eggs" }),
    redirect: "manual",
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.note.title, "Shopping list");
  assert.equal(body.note.content, "Milk and eggs");
  assert.ok(body.note.public_id, "note should carry a public id");
  assert.match(body.note.public_id, /^[0-9a-f-]{36}$/);
  assert.equal("id" in body.note, false, "raw database id must never be exposed");
  assert.equal("userId" in body.note, false, "owner row must never be exposed");
});

test("an empty list is returned as an empty array", async () => {
  const user = await freshUser();
  const sid = await sessionCookieFor(user.id);
  const res = await fetch(`${base}/api/notes`, { headers: authHeaders(sid) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(publicIds(body.notes), []);
});

test("list returns only the signed-in user's notes, without content or raw ids", async () => {
  const alice = await freshUser();
  const bob = await freshUser();
  const aliceSid = await sessionCookieFor(alice.id);

  for (const [title, content] of [
    ["Alice one", "a1"],
    ["Alice two", "a2"],
  ]) {
    await prisma.note.create({ data: { publicId: randomUUID(), title, content, userId: alice.id } });
  }
  await prisma.note.create({ data: { publicId: randomUUID(), title: "Bob secret", content: "b", userId: bob.id } });

  const res = await fetch(`${base}/api/notes`, { headers: authHeaders(aliceSid) });
  assert.equal(res.status, 200);
  const body = await res.json();
  const titles = body.notes.map((n) => n.title);
  assert.deepEqual(titles.sort(), ["Alice one", "Alice two"]);
  assert.ok(body.notes.every((n) => !("content" in n)), "list must not ship full content");
  assert.ok(body.notes.every((n) => !("id" in n) && !("userId" in n)));
});

test("detail is accessible to the owner only; other users get 403, missing gets 404", async () => {
  const alice = await freshUser();
  const bob = await freshUser();
  const aliceNote = await prisma.note.create({
    data: { publicId: randomUUID(), title: "Alice private", content: "top secret", userId: alice.id },
  });
  const aliceSid = await sessionCookieFor(alice.id);
  const bobSid = await sessionCookieFor(bob.id);

  const own = await fetch(`${base}/api/notes/${aliceNote.publicId}`, { headers: authHeaders(aliceSid) });
  assert.equal(own.status, 200);
  const ownBody = await own.json();
  assert.equal(ownBody.note.content, "top secret");

  const cross = await fetch(`${base}/api/notes/${aliceNote.publicId}`, { headers: authHeaders(bobSid) });
  assert.equal(cross.status, 403, "bob reaching alice's note must be forbidden, not served");
  const crossBody = await cross.json();
  assert.equal(crossBody.note, undefined, "no note data may leak to a non-owner");

  const missing = await fetch(`${base}/api/notes/${randomUUID()}`, { headers: authHeaders(bobSid) });
  assert.equal(missing.status, 404);

  const malformed = await fetch(`${base}/api/notes/not-a-uuid`, { headers: authHeaders(bobSid) });
  assert.equal(malformed.status, 400);
});

test("delete is atomic with its audit row, and only the owner can delete", async () => {
  const alice = await freshUser();
  const bob = await freshUser();
  const aliceNote = await prisma.note.create({
    data: { publicId: randomUUID(), title: "To delete", content: "gone soon", userId: alice.id },
  });
  const aliceSid = await sessionCookieFor(alice.id);
  const bobSid = await sessionCookieFor(bob.id);

  const cross = await fetch(`${base}/api/notes/${aliceNote.publicId}`, { method: "DELETE", headers: authHeaders(bobSid) });
  assert.equal(cross.status, 403);
  const stillThere = await prisma.note.findUnique({ where: { id: aliceNote.id } });
  assert.ok(stillThere, "bob's forbidden delete must not remove the note");

  const del = await fetch(`${base}/api/notes/${aliceNote.publicId}`, { method: "DELETE", headers: authHeaders(aliceSid) });
  assert.equal(del.status, 200);

  const goneRow = await prisma.note.findUnique({ where: { id: aliceNote.id } });
  assert.equal(goneRow, null, "note must be fully removed");

  const audit = await prisma.noteDeleteAudit.findFirst({ where: { noteId: aliceNote.id } });
  assert.ok(audit, "a delete audit row must exist");
  assert.equal(audit.notePublicId, aliceNote.publicId);
  assert.equal(audit.title, "To delete");
  assert.equal(audit.deletedBy, alice.id);
  assert.ok(audit.deletedAt instanceof Date);

  const replay = await fetch(`${base}/api/notes/${aliceNote.publicId}`, { method: "DELETE", headers: authHeaders(aliceSid) });
  assert.equal(replay.status, 404, "deleting an already-deleted note must 404");
});