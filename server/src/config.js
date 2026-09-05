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
};

export const isProduction = config.nodeEnv === "production";