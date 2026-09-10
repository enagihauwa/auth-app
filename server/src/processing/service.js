import { prisma } from "../db.js";
import { config } from "../config.js";
import { ROLES } from "./prompts.js";
import * as storage from "./storage.js";
import {
  generateStructured as defaultGenerateStructured,
  ProviderNotConfiguredError,
  ProviderTimeoutError,
  ProviderCallError,
} from "./provider.js";

// The defined retry and the defined graceful failure:
//   - A model call can throw (timeout / SDK error / not configured) -> retry with backoff,
//     then FAILED with a human-readable `error` on the job row.
//   - The model can return JSON that fails OUR schema validation -> retry, feeding the
//     validator's issues back to the model so the next attempt can repair the output;
//     after the last attempt the job FAILS gracefully (never crashes the worker).

export class ValidationFailureError extends Error {
  constructor(role, payload, issues) {
    super(`Model output failed schema validation (${role}).`);
    this.name = "ValidationFailureError";
    this.role = role;
    this.payload = payload;
    this.issues = issues;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roleForJob(job) {
  return job.kind === "EDIT" ? "edit" : "extract";
}

export async function buildParts(job) {
  if (job.kind === "EDIT") {
    const parent = await prisma.processingJob.findUnique({ where: { id: job.parentId } });
    const source = parent?.result ?? {};
    return [{ text: JSON.stringify(source) }];
  }
  const files = await prisma.processingFile.findMany({
    where: { jobId: job.id },
    orderBy: { id: "asc" },
  });
  if (files.length === 0) {
    throw new ProviderCallError("This job has no files to process.");
  }
  const parts = [];
  for (const file of files) {
    const bytes = await storage.get(file.storageKey);
    parts.push({ inlineData: { mimeType: file.mimeType, data: bytes.toString("base64") } });
  }
  return parts;
}

function validationFeedback(error) {
  const problems = error.issues.map((i) => `${i.path.join(".") || "root"}: ${i.message}`);
  return (
    `Your previous JSON did not pass our schema validation. You returned: ` +
    `${JSON.stringify(error.payload).slice(0, 400)}. ` +
    `Fix exactly these issues and return the full corrected JSON: ${problems.slice(0, 5).join("; ")}.`
  );
}

function readableError(err) {
  if (err instanceof ProviderNotConfiguredError) {
    return "The AI slice is not configured yet — paste your GEMINI_API_KEY into server/.env and retry.";
  }
  if (err instanceof ProviderTimeoutError) {
    return err.message;
  }
  if (err instanceof ProviderCallError) {
    return err.message;
  }
  if (err instanceof ValidationFailureError) {
    return "The model kept returning output that failed our schema validation after repeated attempts.";
  }
  return "An internal error occurred while processing this job.";
}

export async function runProcessingJob({ jobId, provider = defaultGenerateStructured }) {
  const job = await prisma.processingJob.findUnique({ where: { id: jobId } });
  if (!job || job.status === "DONE") return;

  const claimed = await prisma.processingJob.updateMany({
    where: { id: jobId, status: "PENDING" },
    data: { status: "PROCESSING", updatedAt: new Date() },
  });
  if (claimed.count === 0) return; // already being processed or terminal

  const role = roleForJob(job);
  const maxAttempts = Math.max(1, config.processing.maxAttempts);
  const baseUserText = job.kind === "EDIT" ? `Requested follow-up action: ${job.input?.action ?? "summarise"}` : "";
  const parts = await buildParts(job);

  let result = null;
  let error = null;
  let feedback = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await prisma.processingJob.update({
      where: { id: jobId },
      data: { attempts: attempt, status: "PROCESSING", updatedAt: new Date() },
    });

    try {
      const payload = await provider({
        role,
        parts,
        userText: [baseUserText, feedback].filter(Boolean).join("\n\n"),
      });
      const parsed = ROLES[role].schema.zod.safeParse(payload);
      if (!parsed.success) {
        throw new ValidationFailureError(role, payload, parsed.error.issues);
      }
      result = parsed.data;
      break;
    } catch (err) {
      if (err instanceof ValidationFailureError) {
        error = err;
        if (attempt < maxAttempts) {
          feedback = validationFeedback(err);
          continue;
        }
      } else if (
        err instanceof ProviderCallError ||
        err instanceof ProviderTimeoutError ||
        err instanceof ProviderNotConfiguredError
      ) {
        error = err;
        if (attempt < maxAttempts) {
          await sleep(config.processing.retryBackoffMs);
          continue;
        }
      } else {
        error = err;
        break; // programming error: do not retry blindly
      }
    }
  }

  if (result) {
    await prisma.processingJob.update({
      where: { id: jobId },
      data: { status: "DONE", result, error: null, updatedAt: new Date() },
    });
  } else {
    await prisma.processingJob.update({
      where: { id: jobId },
      data: { status: "FAILED", error: readableError(error), updatedAt: new Date() },
    });
  }

  return { jobId, status: result ? "DONE" : "FAILED", error: error?.message ?? null };
}