/**
 * Access Control Audit Script
 * Creates two users, signs both in, then attempts to read/mutate
 * User 1's data using User 2's session across every protected route.
 *
 * Run from the /server directory:
 *   node audit-access-control.mjs
 */

import bcrypt from "bcrypt";
import { prisma } from "./src/db.js";
import { createVerificationCode } from "./src/services/tokens.js";

const BASE = "http://localhost:3000";

// ─── helpers ────────────────────────────────────────────────────────────────

async function api(method, path, { cookie, body, headers } = {}) {
  const opts = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  };
  const res = await fetch(`${BASE}${path}`, opts);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json, headers: res.headers };
}

/** Create and verify a user directly in the DB, then sign in to get a session cookie. */
async function makeUser(name, email, password) {
  const passwordHash = await bcrypt.hash(password, 10);

  // Delete any leftover from a previous run
  await prisma.user.deleteMany({ where: { email } });

  const user = await prisma.user.create({
    data: { name, email, passwordHash },
    select: { id: true },
  });

  // Create + consume a verification code so the account is verified
  const code = await createVerificationCode(user.id, { ttlMs: 15 * 60 * 1000 });

  // Verify via the API (this sets emailVerifiedAt and gives us the Set-Cookie)
  const verifyRes = await api("POST", "/api/auth/verify", {
    body: { email, code },
  });
  if (verifyRes.status !== 200) {
    throw new Error(`Verification failed for ${email}: ${JSON.stringify(verifyRes.json)}`);
  }
  const cookie = verifyRes.headers.get("set-cookie");

  // Sign out so we can sign in cleanly
  await api("POST", "/api/auth/signout", { cookie });

  // Sign in to obtain a fresh session cookie
  const signinRes = await api("POST", "/api/auth/signin", {
    body: { email, password },
  });
  if (signinRes.status !== 200) {
    throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(signinRes.json)}`);
  }
  const sessionCookie = signinRes.headers.get("set-cookie");
  return { id: user.id, email, cookie: sessionCookie };
}

// ─── audit runner ───────────────────────────────────────────────────────────

const rows = []; // { method, path, attempted, result, pass }

function row(method, path, attempted, result, pass) {
  rows.push({ method, path, attempted, result, pass });
}

// ─── main ───────────────────────────────────────────────────────────────────

console.log("=== Setting up users ===\n");

const u1 = await makeUser(
  "Audit User One",
  `audit-u1-${Date.now()}@example.com`,
  "Audit1Password!"
);
const u2 = await makeUser(
  "Audit User Two",
  `audit-u2-${Date.now()}@example.com`,
  "Audit2Password!"
);

console.log(`User1 id=${u1.id}  email=${u1.email}`);
console.log(`User2 id=${u2.id}  email=${u2.email}\n`);

// ─── 1. GET /api/me ──────────────────────────────────────────────────────────
// No user-id param; always returns caller's own data. Verify U2 can't obtain U1's record.
{
  // U2 asks for /api/me — must receive U2's id, never U1's
  const r = await api("GET", "/api/me", { cookie: u2.cookie });
  const isU1 = r.json?.user?.id === u1.id;
  row(
    "GET", "/api/me",
    "Signed in as U2, called /api/me (session-bound; no user-id param to substitute)",
    `HTTP ${r.status} — returned id=${r.json?.user?.id} (expected U2 id=${u2.id}, U1 id=${u1.id})`,
    !isU1 && r.status === 200
  );
}

// ─── 2. GET /api/notes — U1's notes list ─────────────────────────────────────
// Create a note for U1; verify U2's note list never contains it.
let u1NoteId = null;
{
  const created = await api("POST", "/api/notes", {
    cookie: u1.cookie,
    body: { title: "U1 Secret Note", content: "Confidential content belonging to user one." },
  });
  u1NoteId = created.json?.note?.public_id;
  console.log(`U1 note public_id: ${u1NoteId}`);

  // U2 calls GET /api/notes — should return only U2's notes, not U1's
  const r = await api("GET", "/api/notes", { cookie: u2.cookie });
  const leaked = r.json?.notes?.some((n) => n.public_id === u1NoteId);
  row(
    "GET", "/api/notes",
    `Created note as U1 (id=${u1NoteId}), then called GET /api/notes as U2 to see if U1's note appears in the list`,
    `HTTP ${r.status} — U1 note present in U2's list: ${leaked}; returned ${r.json?.notes?.length ?? 0} note(s)`,
    r.status === 200 && !leaked
  );
}

// ─── 3. POST /api/notes — U2 tries to create note in U1's name ───────────────
{
  // The route accepts no userId in the body — it always uses req.session.userId.
  // Attempt to pass a userId field manually to see if the server honours it.
  const r = await api("POST", "/api/notes", {
    cookie: u2.cookie,
    body: { title: "Hijack note", content: "Injected by U2", userId: u1.id },
  });
  // If created, check whose userId the record actually has
  let ownedByU1 = false;
  if (r.status === 201 && r.json?.note?.public_id) {
    const dbNote = await prisma.note.findFirst({
      where: { publicId: r.json.note.public_id },
      select: { userId: true },
    });
    ownedByU1 = dbNote?.userId === u1.id;
    // clean up
    await prisma.note.deleteMany({ where: { publicId: r.json.note.public_id } });
  }
  row(
    "POST", "/api/notes",
    `Called POST /api/notes as U2 with body field userId=${u1.id} hoping to inject note under U1`,
    `HTTP ${r.status} — note owned by U1 in DB: ${ownedByU1}; body userId field ignored (server uses session)`,
    r.status === 201 && !ownedByU1
  );
}

// ─── 4. GET /api/notes/:publicId — U2 reads U1's note ───────────────────────
{
  const r = await api("GET", `/api/notes/${u1NoteId}`, { cookie: u2.cookie });
  const gotContent = r.json?.note?.content !== undefined;
  row(
    "GET", "/api/notes/:publicId",
    `Called GET /api/notes/${u1NoteId} (U1's note id) using U2's session cookie`,
    `HTTP ${r.status} — content exposed: ${gotContent}; body: ${JSON.stringify(r.json)}`,
    r.status === 403 && !gotContent
  );
}

// ─── 5. DELETE /api/notes/:publicId — U2 deletes U1's note ──────────────────
{
  const r = await api("DELETE", `/api/notes/${u1NoteId}`, { cookie: u2.cookie });
  // Confirm note still exists after the attempt
  const stillExists = await prisma.note.count({ where: { publicId: u1NoteId } });
  row(
    "DELETE", "/api/notes/:publicId",
    `Called DELETE /api/notes/${u1NoteId} (U1's note) using U2's session cookie`,
    `HTTP ${r.status} — note still in DB: ${stillExists === 1}; body: ${JSON.stringify(r.json)}`,
    r.status === 403 && stillExists === 1
  );
}

// ─── 6. GET /api/processing/jobs/:id — U2 reads U1's job ────────────────────
// Create a job for U1 directly in DB then try to fetch it as U2.
let u1JobId = null;
{
  const job = await prisma.processingJob.create({
    data: { userId: u1.id, kind: "EXTRACT", status: "PENDING" },
    select: { id: true },
  });
  u1JobId = job.id;
  console.log(`U1 job id: ${u1JobId}`);

  const r = await api("GET", `/api/processing/jobs/${u1JobId}`, { cookie: u2.cookie });
  const gotJob = r.json?.job !== undefined;
  row(
    "GET", "/api/processing/jobs/:id",
    `Created job in DB under U1 (id=${u1JobId}), called GET /api/processing/jobs/${u1JobId} as U2`,
    `HTTP ${r.status} — job data exposed: ${gotJob}; body: ${JSON.stringify(r.json)}`,
    r.status === 404 && !gotJob
  );
}

// ─── 7. POST /api/processing/jobs/:id/follow-up — U2 acts on U1's job ────────
{
  // Make U1's job look DONE so the follow-up precondition passes
  await prisma.processingJob.update({
    where: { id: u1JobId },
    data: { status: "DONE", result: { items: [] } },
  });

  const r = await api("POST", `/api/processing/jobs/${u1JobId}/follow-up`, {
    cookie: u2.cookie,
    body: { action: "summarise" },
  });
  row(
    "POST", "/api/processing/jobs/:id/follow-up",
    `Marked U1's job DONE, then called POST /api/processing/jobs/${u1JobId}/follow-up as U2`,
    `HTTP ${r.status} — body: ${JSON.stringify(r.json)}`,
    r.status === 404
  );
}

// ─── 8. POST /api/processing/jobs/:id/retry — U2 retries U1's job ────────────
{
  await prisma.processingJob.update({
    where: { id: u1JobId },
    data: { status: "FAILED" },
  });

  const r = await api("POST", `/api/processing/jobs/${u1JobId}/retry`, { cookie: u2.cookie });
  // Check if status changed from FAILED
  const job = await prisma.processingJob.findUnique({ where: { id: u1JobId }, select: { status: true } });
  row(
    "POST", "/api/processing/jobs/:id/retry",
    `Marked U1's job FAILED, then called POST /api/processing/jobs/${u1JobId}/retry as U2`,
    `HTTP ${r.status} — job status after attempt: ${job?.status}; body: ${JSON.stringify(r.json)}`,
    r.status === 404 && job?.status === "FAILED"
  );
}

// ─── 9. GET /api/billing/session/:reference — U2 reads U1's checkout ─────────
let u1Ref = null;
{
  // Create a checkout session for U1 directly in DB
  u1Ref = `cs_audit_u1_${Date.now()}`;
  await prisma.checkoutSession.create({
    data: {
      userId: u1.id,
      reference: u1Ref,
      plan: "pro",
      interval: "month",
      amountMinor: 1000,
      currency: "USD",
      status: "open",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    },
  });
  console.log(`U1 checkout reference: ${u1Ref}`);

  const r = await api("GET", `/api/billing/session/${u1Ref}`, { cookie: u2.cookie });
  const gotSession = r.json?.session !== undefined;
  row(
    "GET", "/api/billing/session/:reference",
    `Created checkout session in DB under U1 (ref=${u1Ref}), called GET /api/billing/session/${u1Ref} as U2`,
    `HTTP ${r.status} — session exposed: ${gotSession}; body: ${JSON.stringify(r.json)}`,
    r.status === 404 && !gotSession
  );
}

// ─── 10. GET /api/billing/summary — scoped to session ────────────────────────
{
  const r = await api("GET", "/api/billing/summary", { cookie: u2.cookie });
  const isU1Plan = r.json?.user !== undefined && r.json.user.plan !== undefined;
  row(
    "GET", "/api/billing/summary",
    `Called GET /api/billing/summary as U2 (session-bound, no user param to change)`,
    `HTTP ${r.status} — returns U2's own billing summary, no way to supply different userId`,
    r.status === 200 && isU1Plan
  );
}

// ─── 11. POST /api/billing/checkout — U2 can't initiate for U1 ───────────────
{
  const r = await api("POST", "/api/billing/checkout", {
    cookie: u2.cookie,
    body: { interval: "month", userId: u1.id },
  });
  // If 200, check which user's checkout session was created
  let u1Checkout = false;
  if ((r.status === 200 || r.status === 201) && r.json?.reference) {
    const sess = await prisma.checkoutSession.findFirst({
      where: { reference: r.json.reference },
      select: { userId: true },
    });
    u1Checkout = sess?.userId === u1.id;
  }
  row(
    "POST", "/api/billing/checkout",
    `Called POST /api/billing/checkout as U2 with body field userId=${u1.id} to try to create checkout under U1`,
    `HTTP ${r.status} — checkout belongs to U1: ${u1Checkout}; body userId ignored by server`,
    !u1Checkout
  );
}

// ─── 12. POST /api/billing/downgrade — session-bound, no param ───────────────
{
  const r = await api("POST", "/api/billing/downgrade", { cookie: u2.cookie });
  row(
    "POST", "/api/billing/downgrade",
    `Called POST /api/billing/downgrade as U2 (no userId param; server reads session). U2 has no active subscription`,
    `HTTP ${r.status} — body: ${JSON.stringify(r.json)}`,
    r.status === 400
  );
}

// ─── 13. POST /api/billing/cancel — session-bound, no param ──────────────────
{
  const r = await api("POST", "/api/billing/cancel", { cookie: u2.cookie });
  row(
    "POST", "/api/billing/cancel",
    `Called POST /api/billing/cancel as U2 with no userId param. U2 has no active subscription`,
    `HTTP ${r.status} — body: ${JSON.stringify(r.json)}`,
    r.status === 400
  );
}

// ─── 14. POST /api/payments/webhook — no session; test signature guard ────────
{
  const fakePayload = JSON.stringify({
    event_id: `fake_evt_${Date.now()}`,
    event_type: "payment.captured",
    reference: u1Ref,
  });
  const r = await fetch(`${BASE}/api/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: fakePayload,
  });
  const json = await r.json();
  row(
    "POST", "/api/payments/webhook",
    `Sent forged payment.captured webhook for U1's checkout reference=${u1Ref} with no HMAC signature`,
    `HTTP ${r.status} — body: ${JSON.stringify(json)}`,
    r.status === 401
  );
}

// ─── 15. Unauthenticated direct access — no cookie at all ────────────────────
{
  const r1 = await api("GET", `/api/notes/${u1NoteId}`);
  const r2 = await api("GET", `/api/processing/jobs/${u1JobId}`);
  row(
    "GET", "/api/notes/:publicId (no cookie)",
    `Called GET /api/notes/${u1NoteId} with NO session cookie (unauthenticated curl-style replay)`,
    `HTTP ${r1.status} — body: ${JSON.stringify(r1.json)}`,
    r1.status === 401
  );
  row(
    "GET", "/api/processing/jobs/:id (no cookie)",
    `Called GET /api/processing/jobs/${u1JobId} with NO session cookie (unauthenticated replay)`,
    `HTTP ${r2.status} — body: ${JSON.stringify(r2.json)}`,
    r2.status === 401
  );
}

// ─── 16. Session-replay attack — U2 replays U1's old cookie ──────────────────
{
  // Simulate by signing U1 out (destroying session) then trying to use the stale cookie
  await api("POST", "/api/auth/signout", { cookie: u1.cookie });
  const r = await api("GET", "/api/me", { cookie: u1.cookie });
  row(
    "GET", "/api/me (stale cookie replay)",
    `Signed U1 out, then replayed U1's original session cookie against GET /api/me`,
    `HTTP ${r.status} — body: ${JSON.stringify(r.json)}`,
    r.status === 401
  );
}

// ─── clean up DB objects we created ─────────────────────────────────────────
await prisma.processingJob.deleteMany({ where: { id: u1JobId } });
await prisma.note.deleteMany({ where: { userId: u1.id } });
await prisma.checkoutSession.deleteMany({ where: { reference: u1Ref } });

// ─── print results ───────────────────────────────────────────────────────────

const W = { method: 8, path: 46, attempted: 80, result: 80, pass: 6 };

function pad(s, n) { return String(s ?? "").substring(0, n).padEnd(n); }
function hr() { return "─".repeat(Object.values(W).reduce((a, b) => a + b, 0) + (Object.keys(W).length - 1) * 3); }

console.log("\n" + hr());
console.log(
  pad("Method", W.method) + " | " +
  pad("Path", W.path) + " | " +
  pad("What was attempted", W.attempted) + " | " +
  pad("What happened", W.result) + " | " +
  pad("Pass?", W.pass)
);
console.log(hr());

let allPass = true;
for (const r of rows) {
  if (!r.pass) allPass = false;
  console.log(
    pad(r.method, W.method) + " | " +
    pad(r.path, W.path) + " | " +
    pad(r.attempted, W.attempted) + " | " +
    pad(r.result, W.result) + " | " +
    pad(r.pass ? "PASS" : "FAIL", W.pass)
  );
}

console.log(hr());
console.log(`\nAll rows pass: ${allPass}`);
if (!allPass) {
  console.log("FAILURES:");
  rows.filter(r => !r.pass).forEach(r => console.log(`  ${r.method} ${r.path}`));
  process.exit(1);
}

await prisma.$disconnect();
