-- Runtime toggle for bypassing all rate limiting.
-- Set value to 'false' to disable rate limiting without restarting the server.
CREATE TABLE IF NOT EXISTS "app_settings" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

INSERT INTO app_settings (key, value) VALUES ('rate_limit_enabled', 'true')
ON CONFLICT (key) DO NOTHING;