export const config = {
  port: Number(process.env.PORT ?? 3000),
  nodeEnv: process.env.NODE_ENV ?? "development",
  databaseUrl:
    process.env.DATABASE_URL ??
    "postgres://auth_app:auth_app_dev_password@127.0.0.1:5432/auth_db",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-only-insecure-secret-change-me",
  appUrl: process.env.APP_URL ?? "http://localhost:5173",
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
  ai: {
    // Paste your Google AI Studio key into .env under GEMINI_API_KEY by hand.
    geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  },
  processing: {
    modelId: process.env.PROCESSING_MODEL_ID ?? "gemini-2.5-flash",
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