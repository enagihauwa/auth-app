import rateLimit from "express-rate-limit";
import { config } from "./config.js";

export const signinLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Wait 15 minutes and try again." },
});

export const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many accounts created from this address. Try again in an hour." },
});

export const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many reset requests. Try again in an hour." },
});

export const resendLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many resend requests. Try again in an hour." },
});

export const genericLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 180,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

export const resendCooldownMs = config.timings.resendCooldownMs;