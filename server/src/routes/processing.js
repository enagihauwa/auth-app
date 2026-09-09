import { Router } from "express";
import multer from "multer";
import { prisma } from "../db.js";
import { config } from "../config.js";
import { followUpRequestSchema } from "../processing/schemas.js";
import { validateBody } from "../validate.js";
import {
  processingUploadLimiter,
  processingFollowUpLimiter,
  processingRetryLimiter,
} from "../rateLimit.js";
import { newStorageKey, put } from "../processing/storage.js";
import { enqueue } from "../processing/worker.js";

const router = Router();

function requireUser(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not signed in." });
  }
  next();
}

const ALLOWED_MIME_TYPES = new Set(config.processing.upload.allowedMimeTypes);

function extensionFor(mimeType) {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
    case "application/pdf":
      return ".pdf";
    default:
      return "";
  }
}

function serializeJob(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    attempts: job.attempts,
    error: job.error,
    result: job.result,
    input: job.input,
    parent_id: job.parentId,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    files: Array.isArray(job.files)
      ? job.files.map((f) => ({
          id: f.id,
          storage_key: f.storageKey,
          name: f.originalName,
          mime_type: f.mimeType,
          size_bytes: f.sizeBytes,
        }))
      : [],
  };
}

function handleMulterError(err, res) {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res
      .status(413)
      .json({ error: `Each file must be ${Math.round(config.processing.upload.maxFileBytes / 1024 / 1024)} MB or smaller.` });
  }
  if (err?.code === "LIMIT_FILE_COUNT") {
    return res.status(400).json({ error: `Upload at most ${config.processing.upload.maxFiles} files at once.` });
  }
  if (err?.code === "LIMIT_UNEXPECTED_FILE") {
    return res.status(400).json({ error: "Unexpected file field. Expected the field name 'files'." });
  }
  return res.status(400).json({ error: "The upload could not be read." });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: config.processing.upload.maxFiles,
    fileSize: config.processing.upload.maxFileBytes,
  },
});

// Upload one or more receipts. Enforces type and size restrictions, stores bytes in
// object-storage-equivalent (local disk) with only the storage key saved to the DB,
// creates the EXTRACT job row (PENDING), enqueues it, and returns immediately — the
// request never blocks on the model call.
router.post("/upload", requireUser, processingUploadLimiter, (req, res) => {
  upload.array("files", config.processing.upload.maxFiles)(req, res, async (err) => {
    if (err) return handleMulterError(err, res);

    try {
      const files = req.files ?? [];
      if (files.length === 0) {
        return res.status(400).json({ error: "Choose at least one file to process." });
      }

      const unsupported = files.find((f) => !ALLOWED_MIME_TYPES.has(f.mimetype));
      if (unsupported) {
        return res.status(400).json({
          error: `Unsupported file type: ${unsupported.originalname}. Allowed: ${[...ALLOWED_MIME_TYPES].join(", ")}.`,
        });
      }

      const job = await prisma.processingJob.create({
        data: { userId: req.session.userId, kind: "EXTRACT", status: "PENDING" },
        select: { id: true },
      });

      for (const file of files) {
        const key = newStorageKey(extensionFor(file.mimetype));
        await put(key, file.buffer);
        await prisma.processingFile.create({
          data: {
            jobId: job.id,
            storageKey: key,
            originalName: file.originalname,
            mimeType: file.mimetype,
            sizeBytes: file.size,
          },
        });
      }

      enqueue(job.id);
      return res.status(201).json({ job: { id: job.id, status: "PENDING" } });
    } catch (innerErr) {
      console.error("POST /api/processing/upload failed", innerErr);
      return res.status(500).json({ error: "Something went wrong while saving your upload." });
    }
  });
});

router.get("/jobs/:id", requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: "Invalid job id." });
  }
  const job = await prisma.processingJob.findFirst({
    where: { id, userId: req.session.userId },
    include: { files: true },
  });
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  res.json({ job: serializeJob(job) });
});

// One user-triggered follow-up action on a finished extract: only "summarise" exists
// today. Creates an EDIT job whose input is the parent's structured result and enqueues
// it — the model call happens in the worker, not here.
router.post(
  "/jobs/:id/follow-up",
  requireUser,
  processingFollowUpLimiter,
  validateBody(followUpRequestSchema),
  async (req, res) => {
    const id = Number(req.params.id);
    const parent = await prisma.processingJob.findFirst({
      where: { id, userId: req.session.userId },
    });
    if (!parent) {
      return res.status(404).json({ error: "Job not found." });
    }
    if (parent.kind !== "EXTRACT") {
      return res.status(400).json({ error: "Follow-up actions only apply to a receipt-extraction job." });
    }
    if (parent.status !== "DONE") {
      return res.status(409).json({ error: "Extract the receipt first — this job is not finished." });
    }
    const job = await prisma.processingJob.create({
      data: {
        userId: req.session.userId,
        kind: "EDIT",
        status: "PENDING",
        parentId: parent.id,
        input: { action: req.body.action },
      },
      select: { id: true },
    });
    enqueue(job.id);
    res.status(201).json({ job: { id: job.id, status: "PENDING" } });
  }
);

router.post("/jobs/:id/retry", requireUser, processingRetryLimiter, async (req, res) => {
  const id = Number(req.params.id);
  const job = await prisma.processingJob.findFirst({
    where: { id, userId: req.session.userId },
  });
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  if (job.status !== "FAILED") {
    return res.status(409).json({ error: "Only failed jobs can be retried." });
  }
  const updated = await prisma.processingJob.update({
    where: { id },
    data: { status: "PENDING", error: null, updatedAt: new Date() },
    select: { id: true },
  });
  enqueue(updated.id);
  res.json({ job: { id: updated.id, status: "PENDING" } });
});

export default router;