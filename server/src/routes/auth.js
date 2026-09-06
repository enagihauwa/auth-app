import { Router } from "express";
import bcrypt from "bcrypt";
import { prisma } from "../db.js";
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
  const code = await createVerificationCode(userId, {
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
    const normalizedEmail = email.toLowerCase();

    let userId;
    try {
      const user = await prisma.user.create({
        data: { name, email: normalizedEmail, passwordHash },
        select: { id: true },
      });
      userId = user.id;
    } catch (err) {
      if (err.code === "P2002") {
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
      email: normalizedEmail,
    });
  }
);

router.post(
  "/verify",
  validateBody(verifySchema),
  async (req, res) => {
    const { email, code } = req.body;

    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true },
    });
    if (!user) {
      return res.status(404).json({ error: "No account found with that email." });
    }

    const codeRow = await prisma.emailVerificationCode.findFirst({
      where: {
        userId: user.id,
        codeHash: sha256Hex(code),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!codeRow) {
      return res.status(400).json({ error: "That code is invalid or has expired. Request a new one." });
    }

    await prisma.$transaction([
      prisma.emailVerificationCode.update({
        where: { id: codeRow.id },
        data: { consumedAt: new Date() },
      }),
      prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: new Date(), updatedAt: new Date() },
      }),
    ]);

    req.session.userId = user.id;
    return res.json({ message: "Email verified. You are signed in." });
  }
);

router.post(
  "/resend",
  resendLimiter,
  validateBody(resendSchema),
  async (req, res) => {
    const { email } = req.body;

    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user) {
      return res.status(404).json({ error: "No account found with that email." });
    }
    if (user.emailVerifiedAt) {
      return res.status(400).json({ error: "That email is already verified." });
    }

    const lastCode = await prisma.emailVerificationCode.findFirst({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (
      lastCode &&
      Date.now() - new Date(lastCode.createdAt).getTime() < resendCooldownMs
    ) {
      const wait = Math.ceil(
        (resendCooldownMs - (Date.now() - new Date(lastCode.createdAt).getTime())) / 1000
      );
      return res.status(429).json({ error: `Please wait ${wait} seconds before resending.` });
    }

    await prisma.emailVerificationCode.updateMany({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
      data: { consumedAt: new Date() },
    });

    await sendVerificationCode(user.email, user.id);
    return res.json({ message: "A new code is on its way." });
  }
);

router.post(
  "/signin",
  signinLimiter,
  validateBody(signinSchema),
  async (req, res) => {
    const { email, password } = req.body;

    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase() },
      select: { id: true, name: true, email: true, passwordHash: true, emailVerifiedAt: true },
    });

    const passwordOk =
      user && (await bcrypt.compare(password, user.passwordHash));

    if (!user || !passwordOk) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }

    if (!user.emailVerifiedAt) {
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

    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase() },
      select: { id: true, email: true },
    });

    if (user) {
      const token = await createResetToken(user.id, {
        ttlMs: config.timings.resetTokenTtlMs,
      });
      const resetUrl = `${config.appUrl}/reset?token=${token}`;
      await sendEmail({
        to: user.email,
        ...resetEmail(user.email, resetUrl, config.timings.resetTokenTtlMs / 60000),
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

    const tokenRow = await prisma.passwordResetToken.findFirst({
      where: {
        tokenHash: sha256Hex(token),
        consumedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true, userId: true },
    });
    if (!tokenRow) {
      return res.status(400).json({ error: "That reset link is invalid or has expired. Request a new one." });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

    await prisma.$transaction(async (tx) => {
      await tx.passwordResetToken.update({
        where: { id: tokenRow.id },
        data: { consumedAt: new Date() },
      });
      await tx.user.update({
        where: { id: tokenRow.userId },
        data: { passwordHash, updatedAt: new Date() },
      });
      await tx.$executeRaw`DELETE FROM "session" WHERE sess->>'userId' = ${tokenRow.userId}`;
    });

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