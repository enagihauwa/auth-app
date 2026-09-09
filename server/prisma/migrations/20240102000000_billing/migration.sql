ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users
    ADD CONSTRAINT users_plan_allowed CHECK (plan IN ('free', 'pro'));

CREATE TABLE subscriptions (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active',
    plan TEXT NOT NULL DEFAULT 'pro',
    billing_interval TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    currency CHAR(3) NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    pending_interval TEXT,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT subscriptions_user_id_unique UNIQUE (user_id),
    CONSTRAINT subscriptions_amount_non_negative CHECK (amount_minor >= 0),
    CONSTRAINT subscriptions_interval_allowed CHECK (billing_interval IN ('month', 'year')),
    CONSTRAINT subscriptions_interval_pending_allowed CHECK (pending_interval IN ('month', 'year')),
    CONSTRAINT subscriptions_period_end_after_start CHECK (period_end > period_start)
);

CREATE TABLE checkout_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reference TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL DEFAULT 'pro',
    billing_interval TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    currency CHAR(3) NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT checkout_sessions_amount_non_negative CHECK (amount_minor >= 0),
    CONSTRAINT checkout_sessions_interval_allowed CHECK (billing_interval IN ('month', 'year'))
);

CREATE INDEX checkout_sessions_user_created ON checkout_sessions (user_id, created_at);

CREATE TABLE payment_events (
    id BIGSERIAL PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subscription_id BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL,
    provider_reference TEXT NOT NULL,
    provider_event_id TEXT,
    event_type TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    currency CHAR(3) NOT NULL,
    data JSONB,
    event_key TEXT UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payment_events_amount_non_negative CHECK (amount_minor >= 0)
);

CREATE INDEX payment_events_user_created ON payment_events (user_id, created_at);
CREATE INDEX payment_events_provider_reference ON payment_events (provider_reference);