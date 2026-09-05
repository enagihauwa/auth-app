import { createHash, randomBytes, randomInt } from "node:crypto";

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function randomVerificationCode() {
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

export function randomResetToken() {
  return randomBytes(32).toString("base64url");
}

export async function createVerificationCode(pool, userId, { ttlMs, now = new Date() }) {
  const code = randomVerificationCode();
  await pool.query(
    `INSERT INTO email_verification_codes (user_id, code_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, sha256Hex(code), new Date(now.getTime() + ttlMs)]
  );
  return code;
}

export async function createResetToken(pool, userId, { ttlMs, now = new Date() }) {
  const token = randomResetToken();
  await pool.query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, sha256Hex(token), new Date(now.getTime() + ttlMs)]
  );
  return token;
}