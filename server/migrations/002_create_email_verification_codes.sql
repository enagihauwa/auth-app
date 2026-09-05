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