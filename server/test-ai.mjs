import { strict as assert } from "node:assert";
import { after, test } from "node:test";
import bcrypt from "bcrypt";
import { prisma } from "./src/db.js";
import { config } from "./src/config.js";
import { runProcessingJob } from "./src/processing/service.js";
import { enqueue, queuedCount, recoverStaleJobs } from "./src/processing/worker.js";
import {
  newStorageKey,
  put,
  get,
} from "./src/processing/storage.js";
import {
  ProviderTimeoutError,
  ProviderCallError,
} from "./src/processing/provider.js";
import app from "./src/app.js";

const PORT = 3999;
const server = app.listen(PORT);
after(() => new Promise((resolve) => server.close(resolve)));

const validExtract = () => ({
  merchant: "Cafe",
  invoice_date: null,
  currency: "USD",
  category: null,
  payment_method: "card",
  total_minor: 100,
  tax_minor: 0,
  items: [],
  warnings: [],
});

function fakeProvider(scenario) {
  let calls = 0;
  return async ({ role, userText }) => {
    calls += 1;
    if (scenario === "timeout") throw new ProviderTimeoutError("extract");
    if (scenario === "malformedJson") {
      throw new ProviderCallError("The model returned something that is not valid JSON (extract).");
    }
    if (scenario === "alwaysInvalid") return {};
    if (scenario === "firstDivergentThenValid" && calls === 1) return {};
    if (role === "edit") {
      return {
        action: "summarise",
        summary: "A coffee for the team meeting.",
        bullet_points: ["One coffee"],
        word_count: 7,
      };
    }
    return validExtract();
  };
}

async function freshUser() {
  const n = Date.now() + Math.floor(Math.random() * 1e9);
  return prisma.user.create({
    data: {
      name: `Test ${n}`,
      email: `test-${n}@example.test`,
      passwordHash: bcrypt.hashSync("password", 10),
      emailVerifiedAt: new Date(),
    },
  });
}

async function makeExtractJob(userId, storageKey) {
  const job = await prisma.processingJob.create({ data: { userId, kind: "EXTRACT" } });
  if (storageKey) {
    await prisma.processingFile.create({
      data: {
        jobId: job.id,
        storageKey,
        originalName: "receipt.jpg",
        mimeType: "image/jpeg",
        sizeBytes: 100,
      },
    });
  }
  return job;
}

async function sessionCookieFor(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const res = await fetch(`${base}/api/auth/signin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: user.email, password: "password" }),
  });
  assert.equal(res.status, 200, `login should succeed for ${user.email}`);
  const setCookie = res.headers.get("set-cookie");
  return setCookie.split(";")[0];
}

const base = `http://127.0.0.1:${PORT}`;

// ---------------- service layer ----------------

test("runProcessingJob succeeds and validates output against the schema", async () => {
  const user = await freshUser();
  const key = newStorageKey(".jpg");
  await put(key, Buffer.from("fake-image"));
  const job = await makeExtractJob(user.id, key);
  const result = await runProcessingJob({ jobId: job.id, provider: fakeProvider() });
  assert.equal(result.status, "DONE");
  const saved = await prisma.processingJob.findUnique({ where: { id: job.id } });
  assert.equal(saved.status, "DONE");
  assert.equal(saved.result.merchant, "Cafe");
  assert.equal(saved.error, null);
});

test("retries with validation feedback when the first output fails the schema", async () => {
  const user = await freshUser();
  const key = newStorageKey(".jpg");
  await put(key, Buffer.from("fake-image"));
  const job = await makeExtractJob(user.id, key);
  let feedback = "";
  const provider = fakeProvider("firstDivergentThenValid");
  const wrapped = async (args) => {
    feedback = args.userText;
    return provider(args);
  };
  const result = await runProcessingJob({ jobId: job.id, provider: wrapped });
  assert.equal(result.status, "DONE");
  assert.ok(feedback.length > 0, "the model must receive validation feedback");
  assert.match(feedback, /schema validation/i);
  const saved = await prisma.processingJob.findUnique({ where: { id: job.id } });
  assert.equal(saved.status, "DONE");
  assert.ok(saved.attempts >= 2);
});

test("records a graceful failure when output keeps failing validation", async () => {
  const user = await freshUser();
  const key = newStorageKey(".jpg");
  await put(key, Buffer.from("fake-image"));
  const job = await makeExtractJob(user.id, key);
  const result = await runProcessingJob({ jobId: job.id, provider: fakeProvider("alwaysInvalid") });
  assert.equal(result.status, "FAILED");
  const saved = await prisma.processingJob.findUnique({ where: { id: job.id } });
  assert.equal(saved.status, "FAILED");
  assert.ok(saved.error && saved.error.length > 0);
  assert.equal(saved.attempts, config.processing.maxAttempts);
});

test("timeouts are retried and recorded honestly on exhaustion", async () => {
  const user = await freshUser();
  const key = newStorageKey(".jpg");
  await put(key, Buffer.from("fake-image"));
  const job = await makeExtractJob(user.id, key);
  const result = await runProcessingJob({ jobId: job.id, provider: fakeProvider("timeout") });
  assert.equal(result.status, "FAILED");
  const saved = await prisma.processingJob.findUnique({ where: { id: job.id } });
  assert.equal(saved.status, "FAILED");
  assert.match(saved.error, /timed out/i);
  assert.equal(saved.attempts, config.processing.maxAttempts);
});

test("malformed JSON from the provider becomes a FAILED job, not a crash", async () => {
  const user = await freshUser();
  const key = newStorageKey(".jpg");
  await put(key, Buffer.from("fake-image"));
  const job = await makeExtractJob(user.id, key);
  const result = await runProcessingJob({ jobId: job.id, provider: fakeProvider("malformedJson") });
  assert.equal(result.status, "FAILED");
  assert.match(result.error, /not valid JSON/i);
});

test("a job already processing is not claimed twice", async () => {
  const user = await freshUser();
  const key = newStorageKey(".jpg");
  await put(key, Buffer.from("fake-image"));
  const job = await makeExtractJob(user.id, key);

  let release;
  const gate = new Promise((res) => (release = res));
  let entered = 0;
  const provider = async () => {
    entered += 1;
    await gate;
    return validExtract();
  };

  const run1 = runProcessingJob({ jobId: job.id, provider });
  await new Promise((r) => setTimeout(r, 30));
  const run2 = runProcessingJob({ jobId: job.id, provider });
  release();
  await Promise.all([run1, run2]);
  assert.equal(entered, 1, "the second claim must not re-enter the model");
});

test("storage keeps only the key in the database; bytes round-trip", async () => {
  const user = await freshUser();
  const key = newStorageKey(".png");
  const payload = Buffer.from("PNG-example");
  await put(key, payload);
  const job = await makeExtractJob(user.id, key);
  const file = await prisma.processingFile.findFirst({
    where: { jobId: job.id },
    orderBy: { id: "asc" },
  });
  assert.equal(file.storageKey, key);
  const bytes = await get(key);
  assert.deepEqual(bytes, payload);
});

// ---------------- worker layer ----------------

test("recoverStaleJobs marks interrupted PROCESSING jobs as failed (honestly)", async () => {
  const user = await freshUser();
  // clear stray PENDING rows so recovery does not requeue real-provider jobs
  await prisma.processingJob.updateMany({ where: { status: "PENDING" }, data: { status: "FAILED", error: "test cleanup" } });
  const stuck = await prisma.processingJob.create({
    data: { userId: user.id, kind: "EXTRACT", status: "PROCESSING" },
  });
  await recoverStaleJobs();
  const failed = await prisma.processingJob.findUnique({ where: { id: stuck.id } });
  assert.equal(failed.status, "FAILED");
  assert.match(failed.error, /restarted/i);
});

test("queuedCount reflects enqueued jobs", async () => {
  const before = queuedCount();
  enqueue(999999); // nonexistent id: resolves immediately, never calls a provider
  assert.ok(queuedCount() >= before + 1);
  await new Promise((r) => setTimeout(r, 20));
});

test("the worker never exceeds the configured concurrency cap", async () => {
  const user = await freshUser();
  const jobIds = [];
  for (let i = 0; i < 6; i++) {
    const key = newStorageKey(".jpg");
    await put(key, Buffer.from(`image-${i}`));
    const job = await makeExtractJob(user.id, key);
    jobIds.push(job.id);
  }

  let inFlight = 0;
  let peak = 0;
  const slow = async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 40));
    inFlight -= 1;
    return validExtract();
  };

  for (const id of jobIds) enqueue(id, { provider: slow });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const done = await prisma.processingJob.count({ where: { id: { in: jobIds }, status: "DONE" } });
    if (done === jobIds.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const done = await prisma.processingJob.count({ where: { id: { in: jobIds }, status: "DONE" } });
  assert.equal(done, jobIds.length, "all jobs should finish");
  assert.ok(peak >= 2, "jobs should actually run in parallel");
  assert.ok(peak <= config.processing.concurrency, `peak ${peak} must respect the cap of ${config.processing.concurrency}`);
});

// ---------------- HTTP layer ----------------

test("unauthenticated requests to processing endpoints are rejected (401)", async () => {
  const res = await fetch(`${base}/api/processing/upload`, { method: "POST" });
  assert.equal(res.status, 401);
  const job = await fetch(`${base}/api/processing/jobs/1`);
  assert.equal(job.status, 401);
  const followUp = await fetch(`${base}/api/processing/jobs/1/follow-up`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "summarise" }),
  });
  assert.equal(followUp.status, 401);
});

test("upload rejects unsupported types (400) and oversized files (413) before any job", async () => {
  const user = await freshUser();
  const cookie = await sessionCookieFor(user.id);

  const badType = new FormData();
  badType.append("files", new Blob(["hello"], { type: "text/plain" }), "note.txt");
  const typeRes = await fetch(`${base}/api/processing/upload`, { method: "POST", headers: { cookie }, body: badType });
  assert.equal(typeRes.status, 400);
  assert.match((await typeRes.json()).error, /Unsupported file type/i);

  const tooBig = Buffer.alloc(6 * 1024 * 1024);
  const bigForm = new FormData();
  bigForm.append("files", new Blob([tooBig], { type: "image/jpeg" }), "big.jpg");
  const sizeRes = await fetch(`${base}/api/processing/upload`, { method: "POST", headers: { cookie }, body: bigForm });
  assert.equal(sizeRes.status, 413);

  const none = await fetch(`${base}/api/processing/upload`, { method: "POST", headers: { cookie } });
  assert.equal(none.status, 400);
});

test("follow-up actions are guarded: not-yet-done jobs get 409", async () => {
  const user = await freshUser();
  const cookie = await sessionCookieFor(user.id);
  const pending = await prisma.processingJob.create({
    data: { userId: user.id, kind: "EXTRACT", status: "PENDING" },
  });
  const res = await fetch(`${base}/api/processing/jobs/${pending.id}/follow-up`, {
    method: "POST",
    headers: { cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "summarise" }),
  });
  assert.equal(res.status, 409);
});

test("users cannot read each other's jobs (404, not 200)", async () => {
  const owner = await freshUser();
  const other = await freshUser();
  const job = await makeExtractJob(owner.id);
  const cookie = await sessionCookieFor(other.id);
  const res = await fetch(`${base}/api/processing/jobs/${job.id}`, { headers: { cookie } });
  assert.equal(res.status, 404);
});

test("upload returns immediately with a job id and stores only storage keys", async () => {
  const user = await freshUser();
  const cookie = await sessionCookieFor(user.id);
  const started = Date.now();
  const form = new FormData();
  form.append("files", new Blob([Buffer.from("fake receipt")], { type: "image/png" }), "receipt.png");

  const upload = await fetch(`${base}/api/processing/upload`, { method: "POST", headers: { cookie }, body: form });
  const elapsed = Date.now() - started;
  assert.equal(upload.status, 201, `upload should not block on the model (took ${elapsed}ms)`);
  assert.ok(elapsed < 1500, `upload took ${elapsed}ms — it must return immediately`);

  const { job } = await upload.json();
  assert.ok(job.id >= 0);

  const row = await prisma.processingJob.findUnique({
    where: { id: job.id },
    include: { files: true },
  });
  // the worker may or may not have claimed it yet — but it must exist, in a live state,
  // with exactly one file and only a storage key (never the bytes) in the database.
  assert.ok(["PENDING", "PROCESSING"].includes(row.status), `unexpected status ${row.status}`);
  assert.equal(row.files.length, 1);
  assert.match(row.files[0].storageKey, /^uploads\//);

  const view = await fetch(`${base}/api/processing/jobs/${job.id}`, { headers: { cookie } });
  assert.equal(view.status, 200);
  const body = await view.json();
  assert.ok(["PENDING", "PROCESSING"].includes(body.job.status));
});