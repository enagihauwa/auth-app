# DOCUMENTATION

## Section 1: What This Is

This is the **authentication slice** of an app: a user can create an account with an email and password, prove they own the email by entering a six-digit code sent to that address, sign in, see a protected dashboard, sign out, and — if they forget the password — receive a single-use reset link and choose a new one. Every password is stored as a bcrypt hash, every email code and reset token is stored only as its SHA-256 hash, sessions live in Postgres instead of in memory, and every sensitive endpoint is behind both schema validation and rate limits. The client is a small React app (`client/`) whose forms validate with the exact same Zod schemas the server uses, and the server is an Express API (`server/`) that talks to Postgres and sends email through a local SMTP server for development.

Deliberately **not** included: no OAuth or social login, no multi-factor authentication, no roles or permissions (the dashboard is a stub that proves the session works), no account lockout beyond IP rate limiting, no breached-password checks, and no async email queue. These are all real features a production auth system eventually needs, but each of them is a separate slice with its own decisions to make, and this slice stays small so the authentication decisions it does make are visible and reviewable. Notably it also ships no user-facing "change my password while logged in" flow and no graceful email-send pipeline; those gaps are named in Section 7.

**Second slice — subscriptions.** The same two processes now also contain a paid plan: a user on the free plan can open a hosted (simulated) checkout, pay, and be moved to the **Pro** plan monthly or yearly; a monthly Pro user can schedule an upgrade to yearly that is *charged now* at the full yearly price and applied only when the current month ends (no mid-cycle double-billing — the year starts exactly where the month leaves off); a yearly user can schedule a switch to monthly that the server applies when the billing period ends; anyone can cancel and keep Pro until the end of the period, optionally leaving a cancellation reason (a pending paid upgrade blocks cancellation until it applies, since a refund flow is out of scope). The provider side is deliberately mocked in-process — the "payment provider" is a checkout page served by this very server that dispatches signed web- hooks back to it — but the billing logic (idempotent webhook handling, HMAC signature verification, a full payment-event ledger, database-backed subscriptions) is the real thing and would swap to Stripe/Lemon Squeezy by replacing the mock provider module. Everything about the subscription slice is documented in Section 5 and its data model in Section 4; it reuses the Account slice's sessions and `lower(email)` uniqueness without modification.

## Section 2: How To Run It

Prerequisites: **Node.js 22.18 or later** (the dev scripts use `node --env-file-if-exists` and the Prisma client is generated as TypeScript, which Node runs natively from 22.18 on), **PostgreSQL 13+**, and no other process on ports `3000`, `5173`, `1025`, or `8025`. From a fresh clone:

1. Install dependencies from the repository root:

   ```
   npm install
   npm run setup
   ```

   `npm run setup` runs `npm install` inside both `server/` and `client/`.

2. Create the database. With `psql`, connect as a user who can create roles and databases, and run:

   ```sql
   CREATE ROLE auth_app WITH LOGIN PASSWORD 'auth_app_dev_password';
   CREATE DATABASE auth_db OWNER auth_app;
   ```

   That matches the default `DATABASE_URL` the server falls back to. You can instead use your own role/name and set `DATABASE_URL` accordingly in `.env`.

3. Create the environment file:

   ```
   copy .env.example .env
   ```

   The two variables that must not stay as placeholders are `DATABASE_URL` (if you changed it in step 2) and `SESSION_SECRET`. Generate one with:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   The server lives in `server/`, and the Prisma CLI also reads `server/.env` when it runs, so copy the example there too (`copy .env.example server\.env`) or create one with at least `DATABASE_URL` set.

4. Run the migrations:

   ```
   npm run db:migrate
   ```

   This is `prisma migrate deploy`. Prisma records every applied migration in its own `_prisma_migrations` table, so re-running it is safe; it skips what is already applied. For day-to-day schema changes, prefer the dev command `npm run db:dev` (`prisma migrate dev`), which generates a new migration from any schema change and applies it.

   > **Adopting Prisma on a pre-existing database.** If this repository is older than the switch to Prisma, the database already has its tables and an obsolete `schema_migrations` bookkeeping table from the old runner. Point `prisma.config.ts` at that database (via `server/.env`), then record the initial migration as already applied and drop the stale table instead of replaying it:
   >
   > ```
   > npm --prefix server exec prisma migrate resolve --applied 20240101000000_init
   > psql "postgres://.../auth_db" -c "DROP TABLE IF EXISTS schema_migrations;"
   > ```

5. Start everything with one command:

   ```
   npm run dev
   ```

   This starts three processes together (the bundled Mailpit mail server, the API, and the Vite client) via `concurrently`. Wait for the log lines that say the API is listening and Vite is ready.

6. Open <http://localhost:5173> — that is the app. (The API is at <http://localhost:3000>/api/health, and the captured email is at <http://localhost:8025>.)

   If you prefer separate terminals, the same three commands are `npm run dev:mail`, `npm run dev:server`, and `npm run dev:client`. The Vite dev server proxies `/api/*` to port `3000`, so the browser needs no CORS configuration.

**Environment variables** — every one, its source, and what happens without it:

| Variable | Source | Default if missing |
|---|---|---|
| `PORT` | your choice | `3000` |
| `NODE_ENV` | `development` or `production` | `development` |
| `DATABASE_URL` | the database you created in step 2 | `postgres://auth_app:auth_app_dev_password@127.0.0.1:5432/auth_db` |
| `SESSION_SECRET` | you generate it | an insecure dev-only string (fine locally, must be set otherwise) |
| `APP_URL` | your frontend origin | `http://localhost:5173` |
| `SERVER_URL` | this server's origin | `http://localhost:3000` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | your mail server | `127.0.0.1` / `1025` / `false` |
| `SMTP_USER` / `SMTP_PASS` | your mail server; left empty when no auth | unauthenticated |
| `MAIL_FROM` | your choice | `Auth App <auth@localhost>` |
| `VERIFICATION_CODE_TTL_MS` | your choice | `900000` (15 min) |
| `RESET_TOKEN_TTL_MS` | your choice | `1800000` (30 min) |
| `RESEND_COOLDOWN_MS` | your choice | `60000` (60 s) |
| `PAYMENT_WEBHOOK_SECRET` | you generate it | `dev-webhook-secret-change-me` |
| `CHECKOUT_TTL_MS` | your choice | `1800000` (30 min) |
| `PRICING_CURRENCY` | your choice | `USD` |

The shipped `.env.example` documents each variable with a comment and holds no real secrets.

## Section 3: The Flow, Step By Step

**1. The user opens the app.** `/` redirects to `/signin` (routes in `client/src/App.jsx`). On mount, the app calls `GET /api/me` (`server/src/app.js`) with the session cookie; if the server answers 401, the user stays on `/signin`, and if it answers 200 the app bounces to `/dashboard`. This initial check is what makes a browser refresh keep you signed in.

**2. Create an account.** On `client/src/pages/SignupPage.jsx` the user enters name, email, password, and a confirmation. Before anything is sent, the page validates against `signupFormSchema` extended with a confirm-password field (`shared/schemas.js`). On success it `POST`s `{name, email, password}` to `/api/auth/signup` via `client/src/api.js`, which wraps `fetch` with `credentials: "same-origin"`.

In `server/src/routes/auth.js` the `/signup` route:
- runs `signupLimiter` (5 per hour per IP) and `validateBody(signupSchema)`;
- hashes the password with bcrypt, cost 12 (`server/src/routes/auth.js:44`);
- inserts the user, catching the `23505` unique-violation error on `lower(email)` and answering with a deliberately identical generic success message so nobody can use signup to probe which emails exist;
- creates a six-digit code through `createVerificationCode` (`server/src/services/tokens.js`), which stores `sha256(code)` — never the code itself — with a 15-minute expiry;
- sends the email via `server/src/mailer.js` (nodemailer → Mailpit);
- responds `201`, and the client navigates to `/verify?email=…`.

**3. Verify the email.** `client/src/pages/VerifyPage.jsx` shows the email (prefilled from the query string), the six-digit code field, and a resend button. Submitting calls `POST /api/auth/verify` with `{email, code}`. The server looks up the user by `lower(email)`, then looks up a matching, unconsumed, unexpired code (`email_verification_codes`). If found, one transaction: marks that code consumed and stamps `users.email_verified_at`, then sets `req.session.userId` — verification and sign-in happen in the same moment. The client then calls `refresh()` and lands on the dashboard. A wrong or stale code returns a 400 with a plain message ("request a new one"), and no session is created.

**4. The code never arrives / gets lost.** The same page's resend button calls `POST /api/auth/resend`, rate-limited and guarded by a 60-second cooldown (the client also shows a visible countdown). The server consumes any still-active codes for that user — the schema allows only one live code per user — and issues a fresh one. Resending is not possible for an already-verified account.

**5. Sign in.** `client/src/pages/SigninPage.jsx` `POST`s `{email, password}` to `/api/auth/signin` behind `signinLimiter` (10 per 15 minutes). The route loads the user by `lower(email)`, runs `bcrypt.compare`, and answers 401 with the same message for "no such user" and "wrong password" so the endpoint cannot be used to enumerate accounts. If the user exists, has the right password, but `email_verified_at` is null, it answers 403 with `needsVerification: true` and the client routes to `/verify`. Otherwise it sets `req.session.userId` and returns "Signed in."

**6. The dashboard and signing out.** `GET /api/me` is the only authenticated read: it reads `req.session.userId`, loads the user, and if the session is gone or the user was deleted it destroys the session and answers 401. `client/src/pages/DashboardPage.jsx` renders the signed-in name; `POST /api/auth/signout` destroys the session row in Postgres and clears the cookie.

**7. Forgot password.** `client/src/pages/ForgotPage.jsx` `POST`s an email to `/api/auth/forgot`. The server looks the user up, but regardless of whether the account exists it answers the same neutral message — again, no enumeration. If the account does exist, `createResetToken` stores `sha256(token)` of a 32-byte random `base64url` string with a 30-minute expiry, and `resetEmail` in `server/src/mailer.js` builds `APP_URL/reset?token=…` and sends it.

**8. Reset the password.** `client/src/pages/ResetPage.jsx` reads `token` from the URL and `POST`s `{token, password}` to `/api/auth/reset`. The server hashes the incoming token with SHA-256 and looks for a matching, unconsumed, unexpired row. Once found, one transaction: consume the token, write the new bcrypt hash, and `DELETE FROM session WHERE sess->>'userId' = …` — which signs the user out everywhere. The old password stops working immediately because the stored hash changed, and every pre-existing session cookie becomes invalid even if an attacker held one.

## Section 4: The Data Model

### `users` — one row per account

```sql
CREATE TABLE users (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email              TEXT NOT NULL,
    name               TEXT NOT NULL,
    password_hash      TEXT NOT NULL,
    email_verified_at  TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_email_length CHECK (char_length(email) BETWEEN 3 AND 320),
    CONSTRAINT users_name_length CHECK (char_length(name) BETWEEN 1 AND 100),
    CONSTRAINT users_password_hash_is_bcrypt
        CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$')
);
CREATE UNIQUE INDEX users_email_unique_lower ON users (lower(email));
```

- `email` is `TEXT`, not a case-insensitive type, and uniqueness is enforced by the expression index on `lower(email)`. This buys case-insensitive uniqueness — `A@X.com` and `a@x.com` cannot both exist — without depending on a non-standard extension type.
- `email_verified_at` is nullable on purpose: `NULL` is the unverified state, a timestamp is "verified at this time". A boolean column could not carry that, and there is no flow that un-verifies a user, so the timestamp is strictly more information for free.
- The `password_hash` check constraint is the reason the app can be sure it never stores a stray hash format; it only matches real bcrypt strings (`$2a$`/`$2b$`/`$2y$`, two-digit cost, a valid salt+hash payload).

**Constraints that make invalid states impossible here:** `users_email_unique_lower` makes two accounts with the same email impossible even if application code forgets to check; the bcrypt check makes a plaintext or wrongly-formatted password hash impossible to write; the length checks bound what the database will accept.

### `email_verification_codes` — proof-of-ownership codes, hashed at rest

```sql
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
CREATE UNIQUE INDEX email_verification_codes_one_active_per_user
    ON email_verification_codes (user_id)
    WHERE consumed_at IS NULL;
```

- `code_hash` holds `sha256(6digits)` — the printable code exists only in the email, never in the database.
- The partial unique index is the important decision: one user, at most one *live* code. It makes "which of two codes is valid" structurally impossible to ask, and it forces the resend flow to retire the old code before issuing a new one. An expired or consumed code simply does not count, because the index only sees rows where `consumed_at IS NULL` (expiry is a timer, not a state).
- `expires_at > created_at` means a code cannot be inserted already dead.

**Constraints that make invalid states impossible here:** the partial unique index forbids two simultaneously-provable codes per user; the FK with `ON DELETE CASCADE` guarantees a deleted account leaves no orphan codes; the expiry check forbids inserting an already-expired code.

### `password_reset_tokens` — single-use reset links, hashed at rest

```sql
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
```

- Same shape as the verification codes, with two differences: the secret is a 256-bit random string rather than six digits (higher entropy, since it travels inside an email link that can be forwarded), and the hash is unique across *all* rows, active or not, so the lookup by `token_hash` can never match two rows even in the astronomically unlikely event of a collision.
- `consumed_at` marks single-use: the reset transaction sets it and changes the password in the same atomic step, so replaying the same link after a successful reset hits "no row", never a second password change.

**Constraints that make invalid states impossible here:** the unique hash index makes an ambiguous token lookup impossible; the expiry-in-future check prevents inserting an already-dead token; the FK keeps a token from outliving its user.

### `session` — the server-side session store (provided by `connect-pg-simple`)

```sql
CREATE TABLE "session" (
    "sid"    varchar NOT NULL,
    "sess"   json NOT NULL,
    "expire" timestamp(6) NOT NULL,
    PRIMARY KEY ("sid")
);
CREATE INDEX "IDX_session_expire" ON "session" ("expire");
```

This is the table `express-session` writes into via `connect-pg-simple`. The browser holds only a random session ID in an `httpOnly` cookie; everything else (whose user, rolling expiry) lives in `sess` in Postgres. `sid` is the primary key because each cookie ID maps to exactly one stored session, and the expiry index is what lets Postgres clean out dead sessions cheaply. `server/src/app.js:15-34` wires it up: `httpOnly`, `sameSite: lax`, `secure` only in production, seven-day lifetime with sliding renewal (`rolling: true`).

### `subscriptions` — one row per user, current entitlement is just `users.plan`

```sql
CREATE TABLE subscriptions (
    id                   BIGSERIAL PRIMARY KEY,
    user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE NO ACTION,
    status               TEXT NOT NULL DEFAULT 'active',
    plan                 TEXT NOT NULL DEFAULT 'pro',
    billing_interval     TEXT NOT NULL,
    amount_minor         INTEGER NOT NULL,
    currency             CHAR(3) NOT NULL,
    period_start         TIMESTAMPTZ(6) NOT NULL,
    period_end           TIMESTAMPTZ(6) NOT NULL,
    pending_interval     TEXT,
    cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
    cancelled_at         TIMESTAMPTZ(6),
    cancellation_reason  TEXT,
    created_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_user_id_unique ON subscriptions (user_id);
CREATE INDEX payment_events_user_created ... ; -- see PaymentEvent below
```

`subscriptions_user_id_unique` makes the "one subscription per user" invariant structural: `upsert` on `user_id` is safe because the database refuses a second row. `users.plan` (`'free'`/`'pro'`) is the single source of truth that feature checks read; the subscription row carries the *terms* (interval, amounts, period, pending-change flags). All money is integer minor units inside `amount_minor` with `currency` as ISO `CHAR(3)` — no floats anywhere, so "what was charged" can never accumulate the classic `0.1 + 0.2` drift.

### `checkout_sessions` — one open payment attempt

```sql
CREATE TABLE checkout_sessions (
    id            BIGSERIAL PRIMARY KEY,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE NO ACTION,
    reference     TEXT NOT NULL UNIQUE,
    plan          TEXT NOT NULL DEFAULT 'pro',
    billing_interval TEXT NOT NULL,
    amount_minor  INTEGER NOT NULL,
    currency      CHAR(3) NOT NULL,
    status        TEXT NOT NULL DEFAULT 'open',
    created_at    TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    completed_at  TIMESTAMPTZ(6),
    expires_at    TIMESTAMPTZ(6) NOT NULL
);
CREATE INDEX checkout_sessions_user_created ON checkout_sessions (user_id, created_at);
```

`reference` (`cs_<uuid>`) is what the hosted checkout and the webhook both speak in — the user pays reference `X`, the provider's `payment.captured` names reference `X`, and the server links them. `status` moves `open → completed` (or `failed`/`expired`); an `open` session whose `expires_at` passed is swept by the reaper.

### `payment_events` — the ledger

```sql
CREATE TABLE payment_events (
    id                BIGSERIAL PRIMARY KEY,
    user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE NO ACTION,
    subscription_id   BIGINT REFERENCES subscriptions(id) ON DELETE SET NULL ON UPDATE NO ACTION,
    provider_reference TEXT NOT NULL,
    provider_event_id TEXT,
    event_type        TEXT NOT NULL,
    amount_minor      INTEGER NOT NULL,
    currency          CHAR(3) NOT NULL,
    data              JSONB,
    event_key         TEXT UNIQUE,
    created_at        TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX payment_events_user_created ON payment_events (user_id, created_at);
CREATE INDEX payment_events_provider_reference ON payment_events (provider_reference);
```

Every meaningful billing transition writes one immutable row: `checkout_initiated`, `payment_verified`, `subscription_fulfilled`, `upgrade_scheduled`, `downgrade_scheduled`, `interval_change_applied`, `cancellation_scheduled`, `subscription_ended`, `checkout_expired`, `payment_failed`, `duplicate_webhook_ignored`. `data` is a JSONB blob carrying the specifics (the applied-at date of a scheduled switch, reasons, the raw provider payload), so the ledger doubles as an audit trail you can reconstruct any charge from. **`event_key` is the idempotency anchor**: the initiation key is `checkout:<reference>` and every verified webhook gets `webhook:<event_id>`. Because the column is unique, the *same* provider event delivered twice cannot write twice — the second delivery hits the unique violation and is logged as `duplicate_webhook_ignored` rather than charged again.

## Section 5: The Concepts

### Password hashing with bcrypt

- **What it is.** Hashing turns a password into a fixed-length string that cannot be reversed back into the plaintext. On account creation I compute `bcrypt.hash(password, 12)`; on sign-in I run `bcrypt.compare` against the stored hash. The real password is never stored or logged anywhere.
- **Why it is needed.** If the database is ever read by someone who should not have it, plaintext passwords give that person every account immediately — and, because people reuse passwords, the same credentials across other services. Even a stolen hash is useful, so the point is to make the stored form deliberately slow to brute-force.
- **How I implemented it.** `server/src/routes/auth.js:44` hashes at signup and at password reset; `server/src/routes/auth.js:187-190` compares on sign-in. The cost factor 12 is the deliberate slowdown — it costs one honest login a few hundred milliseconds and costs an attacker the same time per guess. The database refuses mismatched formats outright:

  ```sql
  CONSTRAINT users_password_hash_is_bcrypt
      CHECK (password_hash ~ '^\$2[aby]\$[0-9]{2}\$[./A-Za-z0-9]{53}$')
  ```

- **What I chose against, and why.** SHA-256, because it is fast, and in password storage `fast = wrong`: an attacker trying a billion guesses from a stolen hash would find fast hashing the friendliest possible adversary. Argon2id is a defensible and arguably stronger choice, but it needs a separate dependency and platform setup, while bcrypt is trivial in this stack and my reasoning about its cost semantics is well tested. With an equal-strength framing I chose the option I understand completely.

### Hashing email codes and reset tokens at rest

- **What it is.** The verification code and reset token are random one-time secrets. The printable values are sent over email, while the database stores only `sha256(secret)`.
- **Why it is needed.** Email providers keep copies of every message forever, and support staff, password managers, and forwarded mail mean those values are far more widely circulated than a hash in a database. If a reset token stored in plaintext were also stored in a leaked database dump, the two leaks combine into a takeover: an attacker who can query the DB reuses the very link the victim receives. Hashing at rest makes a DB leak useless — there is no way back from the hash to the token.
- **How I implemented it.** `server/src/services/tokens.js` hashes on write; the routes hash on read (`sha256Hex(code)` in `/verify`, `sha256Hex(token)` in `/reset`), so a match is always hash-to-hash:

  ```js
  export function sha256Hex(value) {
    return createHash("sha256").update(value).digest("hex");
  }
  ```

  The `code_hash`/`token_hash` columns are `CHAR(64)` with a format check, and token hashes are globally unique.
- **What I chose against, and why.** Storing the values raw, trivially rejected above. I did consider HMAC with a server key instead of a plain hash — that would protect the token even if both the database and the application secret leaked separately — but a plain `sha256` is honest about its threat model (it separates "code works" from "code readable"), is exactly as secure when the attacker has the DB dump alone, and shipping a second secret to hold and rotate was more machinery than this slice warranted.

### Account enumeration prevention (uniform responses)

- **What it is.** Making the server's answers the same whether an email exists or not, so an outsider cannot learn which addresses have accounts. The trade-off is that legitimate errors get vaguer.
- **Why it is needed.** Every endpoint that answers "no such user" differently from "wrong password" is a free membership test. That leaks into spam, phishing targeted at real accounts, and credential-stuffing that only spends effort on verified emails. Without it, an attacker runs the `/forgot` route once against a list of emails and learns the whole user table, 5 attempts per hour per IP at a time.
- **How I implemented it.** Sign-up returns the identical message whether the INSERT succeeded or hit the `23505` unique violation (`server/src/routes/auth.js:56-61`). Forgot-password only branches internally and returns one constant message ("If that email has an account, a reset link is on its way.") (`server/src/routes/auth.js:211-233`). Sign-in uses one message for both unknown email and wrong password — `bcrypt.compare` runs against a fixed dummy hash when the user does not exist, so the response *timing* does not leak either (`server/src/routes/auth.js:186-193`).
- **What I chose against, and why.** Returning distinct errors ("This email is not registered") because the richer UX is the exact mechanism enumeration exploits; with rate limits it would still be a mail-based oracle across many IPs. I also considered rate-limiting strictly per-account; the catch there is that gives the attacker a per-account lockout ability, which is its own abuse, so the accepted outcome is vaguer errors plus per-IP limits.

### Rate limiting

- **What it is.** Throwing away requests that exceed a per-sender budget inside a time window. This app has per-endpoint limits on signup, sign-in, forgot, and resend, plus one broad limit covering almost everything.
- **Why it is needed.** Without it, sign-in is an unthrottled guessing machine: an attacker can throw tens of thousands of guesses a minute, and each attempt costs a bcrypt compare plus a database query on my server. Similarly, `/forgot` and `/signup` become the enumeration oracle from the previous concept (millions of emails per day if unthrottled), and `/resend` becomes a spam cannon against arbitrary inboxes. Rate limits cap the *rate* of all of these.
- **How I implemented it.** `server/src/rateLimit.js` builds declarative limiters from `express-rate-limit`, mounted per route in `server/src/routes/auth.js`, plus one `genericLimiter` (180/hour) in `server/src/app.js`. Sign-in is protected by two stacked limits so that throttling abuse *cannot* lock out a legitimate user: a per-account key (`ip + lowercased email`, 20 per 15 min) that uses `skipSuccessfulRequests`, so a correct password or typo recovery never consumes budget, and a broader per-IP safety net (60 per 15 min) that catches someone rotating emails. Forgot and resend are likewise keyed by `ip + email` (5/hour) so several users behind one NAT don't triage each other; sign-up stays per-IP (5/hour). The global cap **excludes** the read-only endpoints the page hits constantly (`/api/health`, `/api/me`, `/api/billing/session/:ref`) so the return page's 2-second payment poll — 30 requests per visit — can never hard-lock a real user out of the whole API. `trust proxy` is config-driven (`TRUST_PROXY`, 0 by default) rather than hard-coded, so a direct-connection deployment never trusts a spoofable `X-Forwarded-For` header as the client IP. All budgets are configurable via `config.rateLimit` with `.env` overrides. Every limiter can be bypassed at runtime from the DB: setting `app_settings.rate_limit_enabled` to `'false'` turns all limits off within ~5 seconds (`server/src/services/settings.js` polls the row; the flag is on by default). This exists for development ergonomics, not production — leaving it `'false'` in a deployed environment disables throttling entirely. They return the standard headers so a well-behaved client can back off.
- **What I chose against, and why.** An in-process store class is the honest default here — but note the consequences: everything resets when the server restarts, and it does not count across multiple server instances. A Redis store becomes mandatory the moment the app runs on more than one process, and that is a deployment task, not a correctness one for a single-node slice, so I accepted the limitation and named it in Section 7. I also chose IP-based identity over account-based, deliberately, to stop attackers from weaponising prolonged lockouts of real users — the fix in this slice is to *combine* both identities (`ip + email`) and to stop counting successful sign-ins at all.

### Shared schema validation with Zod (client and server)

- **What it is.** The exact same Zod schemas that `shared/schemas.js` defines are imported by the client forms and by the server route middleware, so the rules for "what is a valid email/password/code" live in precisely one place.
- **Why it is needed.** If the client and server disagree about password rules — say the client allows 6 characters and the server requires 8 — the user gets errors that do not match, or worse, the server rejects what the form proudly accepted. Validation also has to exist server-side regardless of the client: the API is callable by curl and bots, and trusting a browser's form checks would let a single crafted request reach the database with garbage.
- **How I implemented it.** `validateBody` (`server/src/validate.js`) runs `schema.safeParse` and maps errors back to field names for the client's inline display:

  ```js
  export function validateBody(schema) {
    return (req, res, next) => {
      const result = schema.safeParse(req.body);
      if (!result.success) { /* 400 with { error, issues } */ }
      req.body = result.data;
      next();
    };
  }
  ```

  The client calls the same schemas in `SignupPage.jsx`, `SigninPage.jsx`, `ForgotPage.jsx`, `ResetPage.jsx`, and `VerifyPage.jsx` *before* sending, and renders per-field errors from `error.flatten().fieldErrors`.
- **What I chose against, and why.** Two separate validations (a hand-rolled client check plus server checks) because drift between them is exactly the bug I wanted to rule out; sharing one schema file makes "the password rule changed" a one-line change. I also considered a full UI form library (react-hook-form + resolver); Zod alone plus a small `Field` component covered the needs without pulling in a dependency layer that would obscure the validation itself.

### Server-side sessions backed by Postgres (express-session + connect-pg-simple)

- **What it is.** After a successful sign-in or verification, the server stores `session.userId` in a row in the `session` table and hands the browser an opaque `httpOnly` session cookie. "Am I signed in?" is answered by looking the cookie up in the database, not by trusting anything in the cookie.
- **Why it is needed.** A cookie that contains the user's identity (a JWT, say) lets a theft of the cookie be a theft of the account, and there is no way to revoke it centrally short of accepting it forever. Signed-in-ness also has to survive the server restarting: an in-memory session store logs everyone out and, worse, forgets nothing important — but a cookie-only scheme cannot be killed when a password is reset. Storing sessions server-side is what lets `/reset` delete every session for a user in one statement.
- **How I implemented it.** `server/src/app.js:15-34` configures `express-session` with a `connect-pg-simple` store pointed at the `session` table, `rolling: true` for sliding expiry, a seven-day `maxAge`, and `httpOnly` so page scripts cannot read the cookie. `/signin`, `/verify`, and `/signout` only ever mutate `req.session.userId` (routes in `server/src/routes/auth.js`); `GET /api/me` in `server/src/app.js:42-61` is the single read point.
- **What I chose against, and why.** JWTs for signed-in-ness: they are good for auth *between services* but the wrong tool for browser sessions — no server-side revocation, and every client is trusted to hold a value that is only worth stealing. And an in-memory store (the express-session default): it does not survive restart and offers no cross-process sharing, whereas making the database the store costs one indexed lookup per request and buys revocation for free.

### One-time, expiring tokens for verification and reset

- **What it is.** Every verification code and reset token is generated fresh, expires after a short TTL (15 and 30 minutes), and works exactly once: the transaction that accepts it also marks it `consumed_at` in the same atomic step.
- **Why it is needed.** A forever-valid reset link is a standing take-over token: forwarding an old email becomes a live credential indefinitely. A multi-use code makes replay trivial — "show me a code" succeeds twice, which has no legitimate use. Expiry bounds the window in which an attacker who has intercepted one email can act; single-use means the legitimate owner using their own link immediately nullifies any copy the attacker holds.
- **How I implemented it.** TTL is enforced in SQL, so an expired row is structurally rejected — `expires_at > now()` in every lookup (`/verify` and `/reset` in `server/src/routes/auth.js`). Single-use is enforced by writing `consumed_at = now()` inside the same `BEGIN … COMMIT` that verifies the email or changes the password, and `password_reset_tokens.token_hash` is globally unique. Reset additionally deletes all of the user's sessions in that transaction, so accepting the new password also revokes the attacker's cookies.
- **What I chose against, and why.** Expiring tokens by checking timestamps in application code rather than in the query; doing the checks in the SQL WHERE clause means a buggy code path that forgets the guard simply cannot over-accept, because the database itself refuses. I also considered a "verification link" instead of a six-digit code; I chose the code partly because the brief centres on code-based verification, and partly because a code typed into the app is less likely than an email link to be auto-clicked by link-preview robots, which consume single-use secrets.

### The resend cooldown

- **What it is.** A 60-second window after a code is sent before the same user can request another one, enforced on the client (a visible countdown) and, more importantly, on the server (in `/resend`, versus the code row's `created_at`).
- **Why it is needed.** Without a cooldown, the resend route is a free spam relay: call it in a loop and Mailpit (or, in production, a real provider) receives an unlimited stream of emails to one address; with a per-user limit but no cooldown, typo-driven double-clicks would also burn through the hourly budget instantly. A cooldown bounds blast-radius without asking the mail provider for help.
- **How I implemented it.** Server side, `resendCooldownMs` comes from config (default 60 s) and `/resend` compares the newest live code's `created_at` against `now()` (`server/src/routes/auth.js:153-161`), answering 429 with "wait N seconds". Client side, `VerifyPage.jsx` runs the same 60-second countdown so the button is disabled before the server even sees the request — the server is authoritative, the client merely avoids obvious mistakes.
- **What I chose against, and why.** Enforcing the cooldown only on the client: anyone can hit the API directly, so the countdown is cosmetic and the server rule is the real one. And a fixed delay-before-send rather than a cooldown — inserting the sleep into the request path would let an attacker tie up a connection per-IP for 60 seconds each, which is a cheap denial-of-service; a cooldown-on-request leaves the connection free.

### Hosted checkout with a simulated provider

- **What it is.** Starting Pro creates a `checkout_sessions` row and returns a URL on the payment provider's domain. The payer is redirected there, completes (or aborts) the payment, and is returned to the app on `/return?ref=…&status=…`. Entitlement is never granted by the redirect — only by the provider's webhook. In this repo the "provider domain" is the same server: `GET /pay/<reference>` (`server/src/routes/mockProvider.js`) renders a minimal hosted page that "charges" `•••• 4242` and both outcomes POST a signed webhook back to `/api/payments/webhook`, then redirect.
- **Why it is needed.** The redirect must not carry authority: if `/return?status=success` granted Pro, a user could flip the query string. Keeping the *redirect* purely informational and making the *webhook* the only thing that changes `users.plan` is the boundary that separates a real billing system from a lie; the checkout reference (`csrf`-independent, server-generated) is what lets the return page poll the true status via `GET /api/billing/session/:ref`.
- **How I implemented it.** `POST /api/billing/checkout` (rate-limited by `checkoutLimiter`) computes the amount, reuses a still-open session of the same interval instead of stacking duplicates, and returns `{ url, reference }`. The client redirects with `window.location.assign(url)` — a top-level navigation, so back/refresh land back in the app. `client/src/pages/ReturnPage.jsx` polls every 2 s and shows confirmed / failed / "still waiting, nothing has been charged" states; an `ErrorBoundary` guarantees no blank page regardless of what throws.
- **What I chose against, and why.** Implementing Stripe in-host `Checkout` inline, or a full payment iframe: the brief calls for a reusable provider abstraction, and the mock captures the *authority boundary* (webhook is king) without needing credentials. Real cards, SCA, and refunds are named as out-of-scope in Section 7.

### Webhook signature verification (HMAC)

- **What it is.** Every provider webhook carries a signature header `x-webhook-signature: t=<ts>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<ts>.<rawBody>")`. The endpoint re-derives the expected HMAC from the raw body bytes and rejects anything that does not match within a 5-minute timestamp window (`server/src/billing/provider.js`).
- **Why it is needed.** If the endpoint trusted "a POST to /api/payments/webhook with a body", anyone could grant themselves Pro by POSTing `payment.captured`. A shared secret both parties know, but an attacker must guess, is what lets the server tell "really from the provider" from "curl invented this". Signing the *raw* body (not the parsed JSON) closes the classic whitespace/encoding trick, and the timestamp bounds replay of a captured signature.
- **How I implemented it.** `express.json` is configured with an `verify` callback that stashes the untouched bytes on `req.rawBody` (`server/src/app.js`); the webhook route verifies `req.rawBody` against the header with `timingSafeEqual` (constant-time compare), then parses. `PAYMENT_WEBHOOK_SECRET` is injected by config; `t` skew is capped at 5 minutes. The mock provider signs with the same function, so the whole loop exercises real cryptography.
- **What I chose against, and why.** Signature schemes that hash the parsed JSON — parse-order differences across providers make that fragile, and I control the exact raw bytes here. And no re-verification via an out-of-band "you delivered X?" fetch: for a self-hosted mock it is pure ceremony, and it is the kind of thing that must be per-provider in a real integration (Section 7).

### Idempotent webhook processing

- **What it is.** The same provider event delivered twice must produce the same end-state and exactly one charge. The mechanism is a unique `event_key` column: `webhook:<event_id>` exists for at most one `payment_events` row.
- **Why it is needed.** Webhooks are delivered at-least-once by design — real providers retry on network blips and on 5xx, and a provider's own retry plus a manually replayed event is not rare. Without idempotency, a retried `payment.captured` double-applies: two balance entries, two "payment_verified" rows, a subscription period that jumps twice, and a plan grant that races its own updates.
- **How I implemented it.** The route first attempts an `insert` with `event_key = 'webhook:<event_id>'` via `logPaymentEvent`; on a `P2002` unique violation it writes a `duplicate_webhook_ignored` row (no key) and returns `{ok:true, duplicate:true}` — the provider sees success, no re-send happens, and nothing is charged or re-granted. A second guard checks the checkout session's `status` (already-`completed` sessions are not re-fulfilled). `checkout_initiated` gets the same treatment with `checkout:<reference>` so two rapid checkout calls cannot double-open for the same user+interval.
- **What I chose against, and why.** "Last-writer-wins" updates with no ledger: too easy to type-check into a stale write and impossible to audit. A UUID-as-event-id dedupe table maintained by hand — the unique index *is* that table, in the same row as the fact being recorded, which keeps the "insert only if this happened once" atomic instead of a transaction dance.

### Scheduled interval switch (monthly ↔ yearly)

- **What it is.** A monthly subscriber can move to yearly, and a yearly subscriber to monthly, but in both directions the switch is *deferred*: it is recorded as `pending_interval` and the server applies it at the end of the current billing period instead of mid-cycle. A monthly→yearly upgrade additionally *charges now* — the provider captures the full yearly price at checkout, and the year is credited back by starting exactly when the current month ends.
- **Why it is needed.** An immediate monthly→yearly switch either double-bills the overlap (you've already paid for the rest of this month) or forces a prorated credit for unused days — the classic "what did I pay and why" support question. Deferring the start to the period boundary keeps the maths trivial: one period pays the monthly price, the next period is the full year at the full yearly price, and there is never a fractional charge to explain. It also mirrors the existing yearly→monthly downgrade, which must wait for the next billing boundary anyway (retro-refunding the yearly discount mid-year would be a self-inflicted price gap).
- **How I implemented it.** `POST /api/billing/checkout` returns the full yearly price for a monthly→yearly request (no proration); the webhook sets `pending_interval = 'year'` on the still-monthly subscription, logs `upgrade_scheduled` with the `appliedAt` = current `period_end`, and clears any pending cancellation (a paid upgrade is a new commitment). The reaper (`server/src/services/reaper.js`, every 60 s) later applies whichever `pending_interval` exists when `period_end` passes, switching interval + price and logging `interval_change_applied`. The yearly→monthly direction is the same field via `POST /api/billing/downgrade`, with `downgrade_scheduled` logged instead. Because a pending upgrade is *paid for*, `POST /api/billing/cancel` refuses it until it applies (the refund flow is explicitly out of scope in Section 7). The E2E proof: monthly checkout captured 1000, the yearly upgrade checkout captured 10000 while the subscription stayed monthly/1000 with `pending_interval = 'year'`, and after the reaper crossed `period_end` the subscription read yearly/10000 with `interval_change_applied` logged.
- **What I chose against, and why.** Prorating the upgrade and starting the new year immediately: it requires trusting a pro-rata credit and re-reasoning a lower charge, and it overlaps the paid month with the new year. And allowing cancellation while a paid upgrade is pending: without a refund flow it would silently forfeit the prepaid year, so the API refuses it with a clear message rather than lying about the outcome.

### Period-end switches and cancel-at-period-end (the reaper)

- **What it is.** Interval switches in either direction (monthly→yearly and yearly→monthly) and cancellations are all *deferred*: `pending_interval` and `cancel_at_period_end` are stored on the subscription, and an in-process scheduler (`server/src/services/reaper.js`, every 60 s) closes them out when `period_end` passes — switching interval and price, or moving `status → cancelled` + `users.plan → free`, each with a ledger row.
- **Why it is needed.** Yearly is the discounted offer; letting a mid-year switch to monthly also retro-refund the discount would be a self-inflicted price gap, and the monthly→yearly direction should likewise not double-bill the overlap (Section "Scheduled interval switch"), so switches must wait for the next billing boundary. Cancellation that ended Pro instantly would be a bait-and-switch on "keep access until period end", which is the whole point of `cancel_at_period_end`. A one-row-per-user invariant keeps both semantics expressible as fields plus a timer.
- **How I implemented it.** The reaper is a `setInterval` (`.unref()`ed so it never holds the process open) that loads due subscriptions and checks `cancel_at_period_end` before `pending_interval` — a cancelled subscription cannot also switch. It is invoked at startup and on the interval; tests drive `runReaper(now)` directly by backdating `period_end`. `pending_interval` is reaper-agnostic to direction: the same code path applies a scheduled yearly upgrade (already paid for at checkout) and a scheduled monthly downgrade.
- **What I chose against, and why.** Immediate upgrade/downgrade/instant-revoke cancellation: all give the "swindled" user experience for no safety gain. And CRON-style external scheduling: it needs deployment plumbing; an in-process scheduler is honest for a single-node slice and easy to replace (Section 7 names the multi-instance caveat, the same one rate limiting has).

### Money as integer minor units

- **What it is.** `amount_minor` is an integer counting cents/100ths of `currency` (`1000` = `$10.00`); there is no `float` or `numeric`-with-fraction anywhere in billing.
- **Why it is needed.** Floating-point money is the bug that quietly writes `29.999999999` into a charge or a credit. The moment two different renderings disagree about a cent, an auditor and a bank have a reason to talk to you.
- **How I implemented it.** The schema is `INTEGER`; pricing lives in `config.pricing` (`month: 1000`, `year: 10000`); period price changes copy the quantised config values verbatim (no derived cents anywhere), and the client only ever formats `(minor/100).toFixed(2)` for display (`client/src/lib/format.js`). All comparison and math is integer.
- **What I chose against, and why.** `DECIMAL(10,2)` in Postgres: correct too, but Prisma's `Decimal` is awkward to pass through JSON and Zod, and plain integers are the least-bad common denominator for the wire format as well.

## Section 6: What Went Wrong

**1. Every form broke at runtime: `z.flattenError` does not exist in Zod 3.23.8.**
- **Symptom.** The client production build printed, for five files, `` "flattenError" is not exported by "node_modules/zod/v3/external.js" ``, yet the build still "succeeded". No dev-time error appeared because the pages are only hit at runtime.
- **Investigation.** I checked the installed Zod (`node -e ... typeof z.flattenError`) — `undefined`. I checked the exported keys and tried `error.flatten()`, which worked and returned `fieldErrors`. I confirmed the dependency is pinned to `^3.23.8`. The `z.flattenError(error).fieldErrors` call only exists in the Zod v4 API, so the build output contained the call with a `flattenError` that is `undefined` — any invalid submission would have thrown a `TypeError` and shown nothing to the user.
- **Cause.** The code was written against the Zod v4 static method while the project runs Zod v3, and no path exercised it during the original build, so it slipped through.
- **Fix.** Replaced all six call sites (in `SignupPage.jsx`, `SigninPage.jsx`, `ForgotPage.jsx`, `ResetPage.jsx`, and `VerifyPage.jsx`) with the v3 instance API `result.error.flatten().fieldErrors`, and removed the now-unused `z` imports. The build no longer warns, and a form that fails validation now actually shows the field errors.

**2. `GET /api/auth/verify` opened a transaction that was not a transaction.**
- **Symptom.** No visible failure in the happy path — verification worked in testing. But reading `/verify`, it began with `pool.query("BEGIN")`, ran the two UPDATEs, and committed with `pool.query("COMMIT")`.
- **Investigation.** I compared it with the reset route, which does the same two-statement job correctly: it reserves a connection with `pool.connect()` and runs `BEGIN … COMMIT … finally release()` against that one `client`. The `pg` pool dispatches each `pool.query()` to whatever idle connection happens to be free, so a pooled `BEGIN` is not guaranteed to wrap the statements that follow.
- **Cause.** `pool.query("BEGIN")` / `pool.query("COMMIT")` may run on different connections, so under any real concurrency the "transaction" silently degenerates into two independent auto-committed writes: a code could be consumed without the user becoming verified, or vice versa.
- **Fix.** Rewrote `/verify` to grab a dedicated client with `pool.connect()`, exact same shape as `/reset` (`BEGIN` … both UPDATEs … `COMMIT`, `ROLLBACK` on error, `release()` in `finally`). Re-ran the end-to-end flow; verification still succeeds.

**3. My smoke-test script could not read the email that contained the verification code.**
- **Symptom.** The end-to-end test got `404 File not found` hitting Mailpit's API at `GET /api/v1/messages/{ID}` for a message it had just listed.
- **Investigation.** I checked the Mailpit API shape: the list endpoint (`/api/v1/messages`) returns a *snippet* (first part of the body), and the full body lives at `/api/v1/message/{ID}` — a different path. My script guessed the wrong one. I confirmed the correct path returned the full text including the six-digit code and the reset link/hash.
- **Cause.** A test-harness guess, not an application bug — but worth recording because it is the canonical trap of email flows: the value the user needs lives inside the mail body, which a black-box integration test cannot see without the mail server's API.
- **Fix.** The script now searches the list's `Subject` to pick the right message, fetches `/api/v1/message/{ID}`, and extracts the code and reset token from the `Text` body. This also incidentally proved the emails genuinely contain the code and the full reset URL.

**4. A second server instance could not start: `EADDRINUSE :::3000`.**
- **Symptom.** Running `npm run dev:server` in a fresh terminal crashed with `Error: listen EADDRINUSE: address already in use :::3000`, while `GET /api/health` still answered.
- **Investigation.** I checked what was listening on 3000 and whether the process was ours; the division was between my process and one already started earlier with `--watch` from a previous session, which had reloaded and kept serving.
- **Cause.** A leftover server from an earlier session holding the port; my new process correctly refused to start rather than silently double-binding.
- **Fix.** Stopped the duplicate attempt and used the already-running instance; as far as the code was concerned this was a non-bug, and the correct behaviour (fail loudly on a conflict) is what any real deployment would demand. Worth documenting because in a long session the "server won't start" symptom most often means "the old one is still up".

**5. The webhook route was mounted under a prefix it could not be reached at.**
- **Symptom.** The mock provider's post-payment dispatch returned 404: `POST /api/payments/webhook` did not exist.
- **Investigation.** The billing router defined the route as `router.post("/api/payments/webhook", …)` but `app.use("/api/billing", billingRouter)` mounted the whole router under `/api/billing`, making the real path `/api/billing/api/payments/webhook`. The other billing routes (which began `/checkout`, `/cancel`…) were coincidentally fine because prefixes compose; the webhook path happened to hard-code `/api/payments/…`.
- **Cause.** Mixing "path written relative to mount point" and "path written as if absolute" in one router; `checkoutUrl`/`dispatchWebhook` pointed at the intended public path.
- **Fix.** Mounted the billing router at the root (`app.use(billingRouter)`) and wrote every billing route with its full `/api/billing/…` path; the webhook now lives exactly at `/api/payments/webhook`. The E2E re-ran green from checkout through fulfilment.

**6. "No difference detected" vs. Prisma-7 migrate diff heuristics.**
- **Symptom.** `prisma migrate diff --from-empty --to-schema` printed an *empty* diff even for a schema with four new tables.
- **Investigation.** In Prisma 7 the empty→schema path outputs nothing unless shadow DB config is coherent; the reliable drift check is `--from-config-datasource --to-schema <schema>`, which correctly reported "No difference detected" against the applied `20240102000000_billing` migration.
- **Cause.** Tool-behaviour quirk, not a schema gap — but it could mislead at exactly the moment you want to trust migrations.
- **Fix.** Standardised on the `--from-config-datasource` drift check and verified zero drift after `migrate deploy`; noted in the repo runbook so the trap is not re-hit.

## Section 7: What This Slice Does Not Handle

- **Multi-instance rate limiting.** The `express-rate-limit` defaults to an in-memory store: limits reset on restart and are per-process. Before real users touch it behind a load balancer, the limits must move to a shared store such as Redis, or the limits become a "one instance per attacker" speed bump rather than a global one.
- **Asynchronous email.** Sending happens inline in the request path (`sendEmail` awaited in `/signup`, `/resend`, `/forgot`). A slow or briefly down SMTP server turns sign-up and forgot-password into latency and occasional 500s, and there is no retry queue. Real-world mail needs a background worker with retries and dead-letter handling.
- **Breached-password and dictionary checks.** The password policy is length plus character classes. There is no check against known breached passwords (e.g. "Password1!" would pass), which is the single most effective cheap hardening step for credential-stuffing.
- **Multi-factor authentication.** Verification of the *email* is the only second step, and only at sign-up. No TOTP, hardware keys, or re-challenge on sensitive actions.
- **Account lockout.** The only throttle is per-IP rate limiting. There is no per-account counter, deliberately (attackers could lock real users out), but that means a stolen password is unimpeded until an IP limit triggers.
- **Change-password-while-signed-in.** There is no "update my password" page for a logged-in user — the flow only covers password reset from a forgotten/lost state.
- **CSRF tokens.** `sameSite: lax` mitigates top-level cross-site POSTs, and the API is JSON-only, but there is no explicit CSRF token. I would add a synchronizer token or double-submit cookie before treating the session as production-hardened.
- **Verification-code delivery at scale.** Codes and reset links rely on the caller's inbox being reachable; there is no SMS/fallback channel, no "code in the app" path, and no delivery analytics.
- **Deleted-session and token hygiene.** Sessions are removed explicitly on reset/sign-out; the email code and reset-token tables grow with history because consumed rows are not purged. A scheduled cleanup job would be required at scale (and a partial index keeps the active lookups fast meanwhile).
- **Out of scope vs. out of time.** Out of scope by design: OAuth/social providers, MFA, roles and permissions, admin tooling, real template rendering. Billing is now its own implemented slice (second slice, Section 5) with its own honest gap list below. Out of time: none — each slice's own brief is fully implemented and verified; the gaps above and below are the honest list of what stands between this and a production system.
- **Billing is mocked, not a live provider.** The "provider" is a page served by this server that signs and dispatches its own webhooks. Real cards, SCA, refunds, chargebacks, plans-as-dynamic-catalog, and a provider dashboard are not implemented; swapping in Stripe/Recharge/Lemon Squeezy means replacing `server/src/billing/provider.js` (the checkout URL / webhook-verify seam) with the real integration and keeping the authority boundary intact.
- **No PCI scope.** Because no card data is touched — mock provider, no card storage — the app never enters PCI scope. That changes instantly with a real provider, and the choice of *hosted checkout* (as opposed to collecting card details on our form) is what keeps even the future version out of most PCI requirements.
- **Single-instance scheduler.** The reaper is an in-process `setInterval`: on a multi-replica deployment two instances could both process a due subscription. It is guarded well enough for a single node (idempotent-ish writes per transition), but a real deployment wants a leader election or a DB lock (e.g. `SELECT … FOR UPDATE SKIP LOCKED`) around reaper runs — same caveat as the rate limiter's in-memory store.
- **No dunning / smart retry.** A failed recurring payment just leaves the period to lapse; there is no retry ladder, no "payment failed" email to the customer, and no grace-period choreography. The first of those matters the moment periods auto-renew for real money.
- **No cancellation-reactivation or self-serve refunds.** Cancel is one-way (`cancel_at_period_end`); going back means opening a new checkout on a fresh period. A monthly user who has paid for a scheduled yearly upgrade is deliberately blocked from cancelling *until it applies* (the API returns 409) precisely because there is no refund path — undoing that purchase would otherwise forfeit the prepaid year. There is no admin/customer refund flow, which a real business would want before long.
- **Pricing is code, not catalogue.** Prices live in `config.pricing`, not in the database. Fine for one plan, wrong for a real store; a production build would keep plans/prices in `subscriptions`-adjacent catalogue rows so price changes are data, not deploys.

## Section 8: If I Built This Again

I would take email out of the request path from day one — a queue or background worker that the sign-up, resend, and forgot routes hand messages to and then instantly respond. The single most fragile moment in this whole slice is an awaited `sendMail()` blocking a password-reset or account-creation request; in development it is invisible, but the moment a real or degraded SMTP server is involved, the login delays, the 500s ("account created but we could not send the email"), and the code rows whose email never left become the slice's main source of operational pain. Everything else here — hashing at rest, uniform errors, database-backed sessions, single-use expiring tokens — would be rebuilt with the same decisions; the mail pipeline is the one thing I would not.