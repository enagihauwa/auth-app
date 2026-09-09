import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { startupSettingsPoll, isRateLimitEnabled } from "./services/settings.js";

startupSettingsPoll();

const skipIfDisabled = () => async () => !(await isRateLimitEnabled());

/**
 * Build a key generator that scopes the counter to `ip + lowercased email`,
 * so abuse is still throttled per account while legitimate users behind a
 * shared network/IP (or test automation) each get their own budget.
 * Falls back to the plain IP when the body has no email (e.g. malformed
 * requests), which keeps those attempts throttled per IP.
 */
function ipAndAccountKey(field) {
  return (req) => {
    const ip = typeof req.ip === "string" && req.ip ? req.ip : "unknown";
    let account = "";
    if (req.body && typeof req.body === "object" && typeof req.body[field] === "string") {
      account = req.body[field].trim().toLowerCase();
    }
    return `${ip}:${account}`;
  };
}

const isSuccess = (_req, res) => res.statusCode < 400;

export const signinLimiter = rateLimit({
  windowMs: config.rateLimit.signinWindowMs,
  limit: config.rateLimit.signinPerAccount,
  keyGenerator: ipAndAccountKey("email"),
  skip: skipIfDisabled(),
  // A sign-in that actually succeeds must never consume budget: a correct
  // password (or recovering from typos) is not a brute-force attempt.
  skipSuccessfulRequests: true,
  requestWasSuccessful: isSuccess,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many sign-in attempts for this account. Wait 15 minutes and try again.",
  },
});

export const signinPerIpLimiter = rateLimit({
  windowMs: config.rateLimit.signinWindowMs,
  limit: config.rateLimit.signinPerIp,
  skip: skipIfDisabled(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    error: "Too many sign-in attempts from this network. Wait 15 minutes and try again.",
  },
});

export const signupLimiter = rateLimit({
  windowMs: config.rateLimit.signupWindowMs,
  limit: config.rateLimit.signupPerIp,
  skip: skipIfDisabled(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many accounts created from this address. Try again in an hour." },
});

export const forgotLimiter = rateLimit({
  windowMs: config.rateLimit.forgotWindowMs,
  limit: config.rateLimit.forgotPerAccount,
  keyGenerator: ipAndAccountKey("email"),
  skip: skipIfDisabled(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many reset requests. Try again in an hour." },
});

export const resendLimiter = rateLimit({
  windowMs: config.rateLimit.resendWindowMs,
  limit: config.rateLimit.resendPerAccount,
  keyGenerator: ipAndAccountKey("email"),
  skip: skipIfDisabled(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many resend requests. Try again in an hour." },
});

// Read-only endpoints the page hits on every load / while polling are excluded
// from the blunt global cap, so a slow payment confirmation or ordinary
// navigation can never hard-lock a legitimate user out of the whole API.
const SKIP_GLOBAL = ["/api/health", "/api/me", "/api/billing/session/"];

export const genericLimiter = rateLimit({
  windowMs: config.rateLimit.genericWindowMs,
  limit: config.rateLimit.genericMax,
  skip: async (req) =>
    !(await isRateLimitEnabled()) ||
    SKIP_GLOBAL.some((prefix) => req.path.startsWith(prefix)),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests. Try again later." },
});

export const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  skip: skipIfDisabled(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many checkouts started. Try again in a few minutes." },
});

export const resendCooldownMs = config.timings.resendCooldownMs;