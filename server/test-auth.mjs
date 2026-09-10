import { strict as assert } from "node:assert";
import { test } from "node:test";
import bcrypt from "bcrypt";
import { prisma } from "./src/db.js";
import { createVerificationCode, createResetToken, sha256Hex } from "./src/services/tokens.js";

async function freshUser() {
  const n = Date.now() + Math.floor(Math.random() * 1e9);
  return prisma.user.create({
    data: {
      name: `Test User ${n}`,
      email: `test-${n}@example.com`,
      passwordHash: await bcrypt.hash("Password123!", 10),
    },
  });
}

test("createVerificationCode invalidates existing unconsumed code and prevents unique constraint violation", async () => {
  const user = await freshUser();

  // 1. Create first verification code
  const code1 = await createVerificationCode(user.id, { ttlMs: 15 * 60 * 1000 });
  assert.equal(code1.length, 6);

  const activeCodes1 = await prisma.emailVerificationCode.findMany({
    where: { userId: user.id, consumedAt: null },
  });
  assert.equal(activeCodes1.length, 1);
  assert.equal(activeCodes1[0].codeHash, sha256Hex(code1));

  // 2. Create second verification code for same user (should invalidate the first)
  const code2 = await createVerificationCode(user.id, { ttlMs: 15 * 60 * 1000 });
  assert.equal(code2.length, 6);

  const activeCodes2 = await prisma.emailVerificationCode.findMany({
    where: { userId: user.id, consumedAt: null },
  });
  assert.equal(activeCodes2.length, 1);
  assert.equal(activeCodes2[0].codeHash, sha256Hex(code2));

  // Verify the previous one is marked consumed
  const totalCodes = await prisma.emailVerificationCode.findMany({
    where: { userId: user.id },
  });
  assert.equal(totalCodes.length, 2);
  const consumed = totalCodes.filter((c) => c.consumedAt !== null);
  assert.equal(consumed.length, 1);
  assert.equal(consumed[0].codeHash, sha256Hex(code1));
});

test("createVerificationCode succeeds when an expired unconsumed code exists", async () => {
  const user = await freshUser();

  // Create code that expired in the past
  const past = new Date(Date.now() - 60000);
  await prisma.emailVerificationCode.create({
    data: {
      userId: user.id,
      codeHash: sha256Hex("123456"),
      createdAt: new Date(Date.now() - 120000),
      expiresAt: past,
      consumedAt: null,
    },
  });

  // Calling createVerificationCode should invalidate the expired code and create the new one
  const newCode = await createVerificationCode(user.id, { ttlMs: 15 * 60 * 1000 });
  assert.equal(newCode.length, 6);

  const activeCodes = await prisma.emailVerificationCode.findMany({
    where: { userId: user.id, consumedAt: null },
  });
  assert.equal(activeCodes.length, 1);
  assert.equal(activeCodes[0].codeHash, sha256Hex(newCode));
});

test("createResetToken invalidates previous unconsumed reset tokens", async () => {
  const user = await freshUser();

  const token1 = await createResetToken(user.id, { ttlMs: 60 * 60 * 1000 });
  const token2 = await createResetToken(user.id, { ttlMs: 60 * 60 * 1000 });

  const activeTokens = await prisma.passwordResetToken.findMany({
    where: { userId: user.id, consumedAt: null },
  });
  assert.equal(activeTokens.length, 1);
  assert.equal(activeTokens[0].tokenHash, sha256Hex(token2));
});
