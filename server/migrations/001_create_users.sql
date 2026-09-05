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