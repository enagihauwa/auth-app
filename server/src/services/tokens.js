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
  const expiresAt = new Date(now.getTime() + ttlMs);
  await prisma.$transaction([
    prisma.emailVerificationCode.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: now },
    }),
    prisma.emailVerificationCode.create({
      data: {
        userId,
        codeHash: sha256Hex(code),
        expiresAt,
      },
    }),
  ]);
  return code;
}

export async function createResetToken(userId, { ttlMs, now = new Date() }) {
  const token = randomResetToken();
  const expiresAt = new Date(now.getTime() + ttlMs);
  await prisma.$transaction([
    prisma.passwordResetToken.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: now },
    }),
    prisma.passwordResetToken.create({
      data: {
        userId,
        tokenHash: sha256Hex(token),
        expiresAt,
      },
    }),
  ]);
  return token;
}