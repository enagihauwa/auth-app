CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email           TEXT NOT NULL,
    name            TEXT NOT NULL,
    password_hash   TEXT NOT NULL,
    email_verified_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 320),
    CONSTRAINT users_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT users_password_hash_is_bcrypt CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$')
);

CREATE UNIQUE INDEX users_email_unique_lower ON users (lower(email));

CREATE TABLE email_verification_codes (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash     CHAR(64) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ,
    CONSTRAINT email_verification_codes_expiry_in_future CHECK (expires_at > created_at),
    CONSTRAINT email_verification_codes_code_hash_length CHECK (code_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX email_verification_codes_user_active
    ON email_verification_codes (user_id)
    WHERE consumed_at IS NULL;

CREATE UNIQUE INDEX email_verification_codes_one_active_per_user
    ON email_verification_codes (user_id)
    WHERE consumed_at IS NULL;

CREATE TABLE password_reset_tokens (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash    CHAR(64) NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at    TIMESTAMPTZ NOT NULL,
    consumed_at   TIMESTAMPTZ,
    CONSTRAINT password_reset_tokens_expiry_in_future CHECK (expires_at > created_at),
    CONSTRAINT password_reset_tokens_token_hash_length CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE UNIQUE INDEX password_reset_tokens_token_hash_unique ON password_reset_tokens (token_hash);

CREATE TABLE "session" (
    "sid" varchar NOT NULL COLLATE "default",
    "sess" json NOT NULL,
    "expire" timestamp(6) NOT NULL
) WITH (OIDS = FALSE);

ALTER TABLE "session"
    ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX "IDX_session_expire" ON "session" ("expire");