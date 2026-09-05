import { Router } from "express";
import bcrypt from "bcrypt";
import { pool } from "../db.js";
import { config } from "../config.js";
import { sha256Hex, createVerificationCode, createResetToken } from "../services/tokens.js";
import { sendEmail, verificationEmail, resetEmail } from "../mailer.js";
import {
  signupSchema,
  signinSchema,
  verifySchema,
  forgotSchema,
  resetSchema,
  resendSchema,
} from "../../../shared/schemas.js";
import { validateBody } from "../validate.js";
import {
  signinLimiter,
  signupLimiter,
  forgotLimiter,
  resendLimiter,
  resendCooldownMs,
} from "../rateLimit.js";

const router = Router();

const BCRYPT_COST = 12;

async function sendVerificationCode(email, userId) {
  const code = await createVerificationCode(pool, userId, {
    ttlMs: config.timings.verificationCodeTtlMs,
  });
  await sendEmail({
    to: email,
    ...verificationEmail(email, code, config.timings.verificationCodeTtlMs / 60000),
  });
}

router.post(
  "/signup",
  signupLimiter,
  validateBody(signupSchema),
  async (req, res) => {
    const { name, email, password } = req.body;
    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    let userId;
    try {
      const { rows } = await pool.query(
        `INSERT INTO users (name, email, password_hash)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [name, email.toLowerCase(), passwordHash]
      );
      userId = rows[0].id;
    } catch (err) {
      if (err.code === "23505") {
        return res
          .status(200)
          .json({ message: "If that email is available, we sent a verification code." });
      }
      throw err;
    }

    try {
      await sendVerificationCode(email, userId);
    } catch (err) {
      console.error("Failed to send verification email", err);
      return res
        .status(500)
        .json({ error: "Account created but we could not send the email. Resend the code." });
    }

    return res.status(201).json({
      message: "Account created. Check your email for a verification code.",
      email: email.toLowerCase(),
    });
  }
);

router.post(
  "/verify",
  validateBody(verifySchema),
  async (req, res) => {
    const { email, code } = req.body;

    const { rows: users } = await pool.query(
      "SELECT id, email FROM users WHERE lower(email) = lower($1)",
      [email]
    );
    if (users.length === 0) {
      return res.status(404).json({ error: "No account found with that email." });
    }

    const { rows } = await pool.query(
      `SELECT id FROM email_verification_codes
       WHERE user_id = $1
         AND code_hash = $2
         AND consumed_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1`,
      [users[0].id, sha256Hex(code)]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: "That code is invalid or has expired. Request a new one." });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE email_verification_codes SET consumed_at = now() WHERE id = $1",
        [rows[0].id]
      );
      await client.query(
        "UPDATE users SET email_verified_at = now(), updated_at = now() WHERE id = $1",
        [users[0].id]
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    req.session.userId = users[0].id;
    return res.json({ message: "Email verified. You are signed in." });
  }
);

router.post(
  "/resend",
  resendLimiter,
  validateBody(resendSchema),
  async (req, res) => {
    const { email } = req.body;

    const { rows: users } = await pool.query(
      "SELECT id, email FROM users WHERE lower(email) = lower($1)",
      [email]
    );
    if (users.length === 0) {
      return res.status(404).json({ error: "No account found with that email." });
    }
    if (users[0].email_verified_at) {
      return res.status(400).json({ error: "That email is already verified." });
    }

    const { rows: lastCodes } = await pool.query(
      `SELECT created_at FROM email_verification_codes
       WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [users[0].id]
    );
    if (
      lastCodes.length > 0 &&
      Date.now() - new Date(lastCodes[0].created_at).getTime() < resendCooldownMs
    ) {
      const wait = Math.ceil(
        (resendCooldownMs - (Date.now() - new Date(lastCodes[0].created_at).getTime())) / 1000
      );
      return res.status(429).json({ error: `Please wait ${wait} seconds before resending.` });
    }

    await pool.query(
      `UPDATE email_verification_codes SET consumed_at = now()
       WHERE user_id = $1 AND consumed_at IS NULL AND expires_at > now()`,
      [users[0].id]
    );

    await sendVerificationCode(users[0].email, users[0].id);
    return res.json({ message: "A new code is on its way." });
  }
);

router.post(
  "/signin",
  signinLimiter,
  validateBody(signinSchema),
  async (req, res) => {
    const { email, password } = req.body;

    const { rows: users } = await pool.query(
      "SELECT id, name, email, password_hash, email_verified_at FROM users WHERE lower(email) = lower($1)",
      [email]
    );
    const user = users[0];

    const passwordOk =
      user && (await bcrypt.compare(password, user.password_hash));

    if (!user || !passwordOk) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    if (!user.email_verified_at) {
      return res.status(403).json({
        error: "Verify your email before signing in.",
        needsVerification: true,
        email: user.email,
      });
    }

    req.session.userId = user.id;
    return res.json({ message: "Signed in." });
  }
);

router.post(
  "/forgot",
  forgotLimiter,
  validateBody(forgotSchema),
  async (req, res) => {
    const { email } = req.body;

    const { rows: users } = await pool.query(
      "SELECT id, email FROM users WHERE lower(email) = lower($1)",
      [email]
    );

    if (users.length > 0) {
      const token = await createResetToken(pool, users[0].id, {
        ttlMs: config.timings.resetTokenTtlMs,
      });
      const resetUrl = `${config.appUrl}/reset?token=${token}`;
      await sendEmail({
        to: users[0].email,
        ...resetEmail(users[0].email, resetUrl, config.timings.resetTokenTtlMs / 60000),
      });
    }

    return res.json({
      message: "If that email has an account, a reset link is on its way.",
    });
  }
);

router.post(
  "/reset",
  validateBody(resetSchema),
  async (req, res) => {
    const { token, password } = req.body;

    const { rows: tokens } = await pool.query(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token_hash = $1
         AND consumed_at IS NULL
         AND expires_at > now()`,
      [sha256Hex(token)]
    );
    if (tokens.length === 0) {
      return res.status(400).json({ error: "That reset link is invalid or has expired. Request a new one." });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE password_reset_tokens SET consumed_at = now() WHERE id = $1",
        [tokens[0].id]
      );
      await client.query(
        "UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2",
        [passwordHash, tokens[0].user_id]
      );
      await client.query("DELETE FROM session WHERE sess->>'userId' = $1", [tokens[0].user_id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return res.json({ message: "Password reset. Sign in with your new password." });
  }
);

router.post("/signout", (req, res) => {
  if (req.session) {
    req.session.destroy((err) => {
      if (err) {
        console.error("Failed to destroy session", err);
        return res.status(500).json({ error: "Could not sign out." });
      }
      res.clearCookie("sid");
      return res.json({ message: "Signed out." });
    });
  } else {
    res.clearCookie("sid");
    return res.json({ message: "Signed out." });
  }
});

export default router;