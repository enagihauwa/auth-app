export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Number of proxy hops in front of this app. Leave unset (0) when the
  // server is reached directly so a spoofed `X-Forwarded-For` header is never
  // trusted as the client IP. Set to the hop count behind a reverse proxy.
  trustProxy: Number(process.env.TRUST_PROXY ?? 0),
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://auth_app:auth_app_dev_password@127.0.0.1:5432/auth_db",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me",
  appUrl: process.env.APP_URL ?? "http://localhost:5173",
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  billing: {
    providerWebhookSecret: process.env.PAYMENT_WEBHOOK_SECRET ?? "dev-webhook-secret-change-me",
    checkoutTtlMs: Number(process.env.CHECKOUT_TTL_MS ?? 30 * 60 * 1000),
  },
  pricing: {
    currency: process.env.PRICING_CURRENCY ?? "USD",
    pro: {
      month: 1000,
      year: 10000,
    },
  },
  smtp: {
    host: process.env.SMTP_HOST ?? "127.0.0.1",
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER ?? undefined,
    pass: process.env.SMTP_PASS ?? undefined,
    from: process.env.MAIL_FROM ?? "Auth App <auth@localhost>",
  },
  timings: {
    verificationCodeTtlMs: Number(process.env.VERIFICATION_CODE_TTL_MS ?? 15 * 60 * 1000),
    resetTokenTtlMs: Number(process.env.RESET_TOKEN_TTL_MS ?? 30 * 60 * 1000),
    resendCooldownMs: Number(process.env.RESEND_COOLDOWN_MS ?? 60 * 1000),
  },
  rateLimit: {
    signinWindowMs: Number(process.env.SIGNIN_WINDOW_MINUTES ?? 15) * 60 * 1000,
    signinPerAccount: Number(process.env.SIGNIN_PER_ACCOUNT ?? 20),
    signinPerIp: Number(process.env.SIGNIN_PER_IP ?? 60),
    signupWindowMs: Number(process.env.SIGNUP_WINDOW_MINUTES ?? 60) * 60 * 1000,
    signupPerIp: Number(process.env.SIGNUP_PER_IP ?? 5),
    forgotWindowMs: Number(process.env.FORGOT_WINDOW_MINUTES ?? 60) * 60 * 1000,
    forgotPerAccount: Number(process.env.FORGOT_PER_ACCOUNT ?? 5),
    resendWindowMs: Number(process.env.RESEND_WINDOW_MINUTES ?? 60) * 60 * 1000,
    resendPerAccount: Number(process.env.RESEND_PER_ACCOUNT ?? 5),
    genericWindowMs: Number(process.env.GENERIC_WINDOW_MINUTES ?? 60) * 60 * 1000,
    genericMax: Number(process.env.GENERIC_MAX ?? 180),
  },
  ai: {
    // Paste your Google AI Studio key into .env under GEMINI_API_KEY by hand.
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  },
  processing: {
    modelId: process.env.PROCESSING_MODEL_ID ?? "gemini-3.6-flash",
    concurrency: Number(process.env.PROCESSING_CONCURRENCY ?? 2),
    modelTimeoutMs: Number(process.env.PROCESSING_MODEL_TIMEOUT_MS ?? 45 * 1000),
    maxAttempts: Number(process.env.PROCESSING_MAX_ATTEMPTS ?? 3),
    retryBackoffMs: Number(process.env.PROCESSING_RETRY_BACKOFF_MS ?? 1500),
    upload: {
      maxFiles: Number(process.env.PROCESSING_MAX_FILES ?? 6),
      maxFileBytes: Number(process.env.PROCESSING_MAX_FILE_BYTES ?? 5 * 1024 * 1024),
      allowedMimeTypes: (
        process.env.PROCESSING_ALLOWED_MIMES ??
        "image/jpeg,image/png,image/webp,application/pdf"
      ).split(","),
    },
    rateLimits: {
      upload: {
        windowMs: Number(process.env.PROCESSING_UPLOAD_LIMIT_WINDOW_MS ?? 15 * 60 * 1000),
        limit: Number(process.env.PROCESSING_UPLOAD_LIMIT ?? 10),
      },
      followUp: {
        windowMs: Number(process.env.PROCESSING_FOLLOWUP_LIMIT_WINDOW_MS ?? 60 * 60 * 1000),
        limit: Number(process.env.PROCESSING_FOLLOWUP_LIMIT ?? 20),
      },
      retry: {
        windowMs: Number(process.env.PROCESSING_RETRY_LIMIT_WINDOW_MS ?? 15 * 60 * 1000),
        limit: Number(process.env.PROCESSING_RETRY_LIMIT ?? 5),
      },
    },
  },
};

export const isProduction = config.nodeEnv === "production";