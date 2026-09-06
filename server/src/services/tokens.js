import { createHash, randomBytes, randomInt } from "node:crypto";
import { prisma } from "../db.js";

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomVerificationCode() {
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

export function randomResetToken() {
  return randomBytes(32).toString("base64url");
}

export async function createVerificationCode(userId, { ttlMs, now = new Date() }) {
  const code = randomVerificationCode();
  await prisma.emailVerificationCode.create({
    data: {
      userId,
      codeHash: sha256Hex(code),
      expiresAt: new Date(now.getTime() + ttlMs),
    },
  });
  return code;
}

export async function createResetToken(userId, { ttlMs, now = new Date() }) {
  const token = randomResetToken();
  await prisma.passwordResetToken.create({
    data: {
      userId,
      tokenHash: sha256Hex(token),
      expiresAt: new Date(now.getTime() + ttlMs),
    },
  });
  return token;
}