import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

// Local development equivalent of object storage. Files are written to disk under
// server/src/storage/files/uploads; the database only ever holds the storage *key*, never
// the bytes. In production this module is the seam you swap for S3 / GCS / Supabase
// Storage: put/get/remove keep the same signatures and nothing else changes.

export const storageRoot = fileURLToPath(new URL("../storage/files", import.meta.url));

async function resolveKey(key) {
  if (typeof key !== "string" || !key.startsWith("uploads/") || key.includes("..")) {
    throw new Error("Invalid storage key.");
  }
  return path.join(storageRoot, key);
}

export function newStorageKey(extension) {
  const ext = typeof extension === "string" ? extension : "";
  return `uploads/${randomUUID()}${ext}`;
}

export async function put(key, buffer) {
  const target = await resolveKey(key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer);
  return key;
}

export async function get(key) {
  const target = await resolveKey(key);
  return fs.readFile(target);
}

export async function remove(key) {
  const target = await resolveKey(key);
  try {
    await fs.unlink(target);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}