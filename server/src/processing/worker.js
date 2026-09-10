import { prisma } from "../db.js";
import { config } from "../config.js";
import { runProcessingJob } from "./service.js";

// In-process FIFO worker. Uploading N files enqueues N+ jobs but never fires more than
// config.processing.concurrency model calls at once. A job row is the source of truth:
// the worker only ever claims PENDING rows and writes terminal states back to them.
//
// Single-instance caveat (documented in Section 7): this queue lives inside this
// process. Two replicas would each run it, so a real deployment would swap this module
// for a DB-backed FIFO (e.g. `SELECT ... FOR UPDATE SKIP LOCKED`) plus one poller.

const queue = [];
let running = 0;
let started = false;

function dequeueNext() {
  while (running < config.processing.concurrency && queue.length > 0) {
    const entry = queue.shift();
    running += 1;
    runProcessingJob({
      jobId: entry.id,
      ...(entry.provider ? { provider: entry.provider } : {}),
    })
      .catch((err) => {
        console.error(`[worker] job ${entry.id} crashed`, err);
        return prisma.processingJob.update({
          where: { id: entry.id },
          data: { status: "FAILED", error: "The worker crashed while processing this job. Retry it." },
        });
      })
      .finally(() => {
        running -= 1;
        dequeueNext();
      });
  }
}

export function enqueue(jobId, options = {}) {
  queue.push({ id: jobId, ...(options.provider ? { provider: options.provider } : {}) });
  dequeueNext();
}

export function busyCount() {
  return running;
}

export function queuedCount() {
  return queue.length + running;
}

export async function recoverStaleJobs() {
  const staled = await prisma.processingJob.updateMany({
    where: { status: "PROCESSING" },
    data: {
      status: "FAILED",
      error: "Interrupted: the server restarted before this job finished. Retry it.",
      updatedAt: new Date(),
    },
  });
  const pending = await prisma.processingJob.findMany({
    where: { status: "PENDING" },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  for (const job of pending) enqueue(job.id);
  console.log(`[worker] recovered ${staled.count} stale job(s); queued ${pending.length} pending job(s)`);
}

export function startWorker() {
  if (started) return;
  started = true;
  void recoverStaleJobs();
}