# DOCUMENTATION

Two slices, one repository, one document. Each slice is written in its own part with the **same eight-section formula** — *What This Is*, *How To Run It*, *The Flow, Step By Step*, *The Data Model*, *The Concepts*, *What Went Wrong*, *What This Slice Does Not Handle*, *If I Built This Again*. **Part I** is the authentication slice; **Part II** is the billing & subscriptions slice. The two parts share one codebase, one database, and one `npm run dev`; Part II reuses Part I's sessions and `lower(email)` account uniqueness without modification, and assumes Part I's setup.

## Part I — Authentication

### Section 1: What This Is

This is the **authentication slice** of an app: a user can create an account with an email and password, prove they own the email by entering a six-digit code sent to that address, sign in, see a protected dashboard, sign out, and — if they forget the password — receive a single-use reset link and choose a new one. Every password is stored as a bcrypt hash, every email code and reset token is stored only as its SHA-256 hash, sessions live in Postgres instead of in memory, and every sensitive endpoint is behind both schema validation and rate limits. The client is a small React app (`client/`) whose forms validate with the exact same Zod schemas the server uses, and the server is an Express API (`server/`) that talks to Postgres and sends email through a local SMTP server for development.

Deliberately **not** included: no OAuth or social login, no multi-factor authentication, no roles or permissions (the dashboard is a stub that proves the session works), no account lockout beyond IP rate limiting, no breached-password checks, and no async email queue. These are all real features a production auth system eventually needs, but each of them is a separate slice with its own decisions to make, and this slice stays small so the authentication decisions it does make are visible and reviewable. Notably it also ships no user-facing "change my password while logged in" flow and no graceful email-send pipeline; those gaps are named in Section 7.

### Section 2: How To Run It

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
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | your mail server | `127.0.0.1` / `1025` / `false` |
| `SMTP_USER` / `SMTP_PASS` | your mail server; left empty when no auth | unauthenticated |
| `MAIL_FROM` | your choice | `Auth App <auth@localhost>` |
| `VERIFICATION_CODE_TTL_MS` | your choice | `900000` (15 min) |
| `RESET_TOKEN_TTL_MS` | your choice | `1800000` (30 min) |
| `RESEND_COOLDOWN_MS` | your choice | `60000` (60 s) |

The shipped `.env.example` documents each variable with a comment and holds no real secrets. Billing adds its own variables (`SERVER_URL`, `PAYMENT_WEBHOOK_SECRET`, `CHECKOUT_TTL_MS`) plus a rate-limit group; Part II Section 2 lists them.

### Section 3: The Flow, Step By Step

**1. The user opens the app.** `/` redirects to `/signin` (routes in `client/src/App.jsx`). On mount, the app calls `GET /api/me` (`server/src/app.js`) with the session cookie; if the server answers 401, the user stays on `/signin`, and if it answers 200 the app bounces to `/dashboard`. This initial check is what makes a browser refresh keep you signed in.

**2. Create an account.** On `client/src/pages/SignupPage.jsx` the user enters name, email, password, and a confirmation. Before anything is sent, the page validates against `signupFormSchema` extended with a confirm-password field (`shared/schemas.js`). On success it `POST`s `{name, email, password}` to `/api/auth/signup` via `client/src/api.js`, which wraps `fetch` with `credentials: "same-origin"`.

In `server/src/routes/auth.js` the `/signup` route:
- runs `signupLimiter` (5 per hour per IP) and `validateBody(signupSchema)`;
- hashes the password with bcrypt, cost 12 (`server/src/routes/auth.js:51`);
- inserts the user, catching the `23505` unique-violation error on `lower(email)` and answering with a deliberately identical generic success message so nobody can use signup to probe which emails exist;
- creates a six-digit code through `createVerificationCode` (`server/src/services/tokens.js`), which stores `sha256(code)` — never the code itself — with a 15-minute expiry;
- sends the email via `server/src/mailer.js` (nodemailer → Mailpit);
- responds `201`, and the client navigates to `/verify?email=…`.

**3. Verify the email.** `client/src/pages/VerifyPage.jsx` shows the email (prefilled from the query string), the six-digit code field, and a resend button. Submitting calls `POST /api/auth/verify` with `{email, code}`. The server looks up the user by `lower(email)`, then looks up a matching, unconsumed, unexpired code (`email_verification_codes`). If found, one transaction: marks that code consumed and stamps `users.email_verified_at`, then sets `req.session.userId` — verification and sign-in happen in the same moment. The client then calls `refresh()` and lands on the dashboard. A wrong or stale code returns a 400 with a plain message ("request a new one"), and no session is created.

**4. The code never arrives / gets lost.** The same page's resend button calls `POST /api/auth/resend`, rate-limited and guarded by a 60-second cooldown (the client also shows a visible countdown). The server consumes any still-active codes for that user — the schema allows only one live code per user — and issues a fresh one. Resending is not possible for an already-verified account.

**5. Sign in.** `client/src/pages/SigninPage.jsx` `POST`s `{email, password}` to `/api/auth/signin` behind stacked `signinLimiter` and `signinPerIpLimiter` limits (per-account and per-IP; both 15-minute windows). The route loads the user by `lower(email)`, runs `bcrypt.compare`, and answers 401 with the same message for "no such user" and "wrong password" so the endpoint cannot be used to enumerate accounts. If the user exists, has the right password, but `email_verified_at` is null, it answers 403 with `needsVerification: true` and the client routes to `/verify`. Otherwise it sets `req.session.userId` and returns "Signed in."

**6. The dashboard and signing out.** `GET /api/me` is the only authenticated read: it reads `req.session.userId`, loads the user, and if the session is gone or the user was deleted it destroys the session and answers 401. `client/src/pages/DashboardPage.jsx` renders the signed-in name; `POST /api/auth/signout` destroys the session row in Postgres and clears the cookie.

**7. Forgot password.** `client/src/pages/ForgotPage.jsx` `POST`s an email to `/api/auth/forgot`. The server looks the user up, but regardless of whether the account exists it answers the same neutral message — again, no enumeration. If the account does exist, `createResetToken` stores `sha256(token)` of a 32-byte random `base64url` string with a 30-minute expiry, and `resetEmail` in `server/src/mailer.js` builds `APP_URL/reset?token=…` and sends it.

**8. Reset the password.** `client/src/pages/ResetPage.jsx` reads `token` from the URL and `POST`s `{token, password}` to `/api/auth/reset`. The server hashes the incoming token with SHA-256 and looks for a matching, unconsumed, unexpired row. Once found, one transaction: consume the token, write the new bcrypt hash, and `DELETE FROM session WHERE sess->>'userId' = …` — which signs the user out everywhere. The old password stops working immediately because the stored hash changed, and every pre-existing session cookie becomes invalid even if an attacker held one.

### Section 4: The Data Model

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

> The billing slice (Part II, Section 4) adds `plan TEXT NOT NULL DEFAULT 'free'` with a `CHECK (plan IN ('free','pro'))` to this table; entitlement is granted only by a paid, webhook-verified checkout.

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

This is the table `express-session` writes into via `connect-pg-simple`. The browser holds only a random session ID in an `httpOnly` cookie; everything else (whose user, rolling expiry) lives in `sess` in Postgres. `sid` is the primary key because each cookie ID maps to exactly one stored session, and the expiry index is what lets Postgres clean out dead sessions cheaply. `server/src/app.js:34-53` wires it up: `httpOnly`, `sameSite: lax`, `secure` only in production, seven-day lifetime with sliding renewal (`rolling: true`).

### Section 5: The Concepts

### Password hashing with bcrypt

- **What it is.** Hashing turns a password into a fixed-length string that cannot be reversed back into the plaintext. On account creation I compute `bcrypt.hash(password, 12)`; on sign-in I run `bcrypt.compare` against the stored hash. The real password is never stored or logged anywhere.
- **Why it is needed.** If the database is ever read by someone who should not have it, plaintext passwords give that person every account immediately — and, because people reuse passwords, the same credentials across other services. Even a stolen hash is useful, so the point is to make the stored form deliberately slow to brute-force.
- **How I implemented it.** `server/src/routes/auth.js:51` hashes at signup and `server/src/routes/auth.js:255` at password reset; `server/src/routes/auth.js:186-189` compares on sign-in. The cost factor 12 is the deliberate slowdown — it costs one honest login a few hundred milliseconds and costs an attacker the same time per guess. The database refuses mismatched formats outright:

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
- **How I implemented it.** Sign-up returns the identical message whether the INSERT succeeded or hit the `23505` unique violation (`server/src/routes/auth.js:62-66`). Forgot-password only branches internally and returns one constant message ("If that email has an account, a reset link is on its way.") (`server/src/routes/auth.js:208-234`). Sign-in uses one message for both unknown email and wrong password — `bcrypt.compare` runs against a fixed dummy hash when the user does not exist, so the response *timing* does not leak either (`server/src/routes/auth.js:186-189`).
- **What I chose against, and why.** Returning distinct errors ("This email is not registered") because the richer UX is the exact mechanism enumeration exploits; with rate limits it would still be a mail-based oracle across many IPs. I also considered rate-limiting strictly per-account; the catch there is that gives the attacker a per-account lockout ability, which is its own abuse, so the accepted outcome is vaguer errors plus per-IP limits.

### Rate limiting

- **What it is.** Throwing away requests that exceed a per-sender budget inside a time window. This app has per-endpoint limits on signup, sign-in, forgot, and resend, plus one broad limit covering almost everything.
- **Why it is needed.** Without it, sign-in is an unthrottled guessing machine: an attacker can throw tens of thousands of guesses a minute, and each attempt costs a bcrypt compare plus a database query on my server. Similarly, `/forgot` and `/signup` become the enumeration oracle from the previous concept (millions of emails per day if unthrottled), and `/resend` becomes a spam cannon against arbitrary inboxes. Rate limits cap the *rate* of all of these.
- **How I implemented it.** `server/src/rateLimit.js` builds declarative limiters from `express-rate-limit`, mounted per route in `server/src/routes/auth.js`, plus one `genericLimiter` (180/hour) in `server/src/app.js:25`. Sign-in is protected by two stacked limits so that throttling abuse *cannot* lock out a legitimate user: a per-account key (`ip + lowercased email`, 20 per 15 min) that uses `skipSuccessfulRequests`, so a correct password or typo recovery never consumes budget, and a broader per-IP safety net (60 per 15 min) that catches someone rotating emails. Forgot and resend are likewise keyed by `ip + email` (5/hour) so several users behind one NAT don't triage each other; sign-up stays per-IP (5/hour). The global cap **excludes** the read-only endpoints the page hits constantly (`/api/health`, `/api/me`, `/api/billing/session/:ref`) so the return page's 2-second payment poll — 30 requests per visit — can never hard-lock a real user out of the whole API. `trust proxy` is config-driven (`TRUST_PROXY`, 0 by default) rather than hard-coded, so a direct-connection deployment never trusts a spoofable `X-Forwarded-For` header as the client IP. All budgets are configurable via `config.rateLimit` with `.env` overrides. Every limiter can be bypassed at runtime from the DB: setting `app_settings.rate_limit_enabled` to `'false'` turns all limits off within ~5 seconds (`server/src/services/settings.js` polls the row; the flag is on by default). This exists for development ergonomics, not production — leaving it `'false'` in a deployed environment disables throttling entirely. They return the standard headers so a well-behaved client can back off.
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

  The client calls the same schemas in `SignupPage.jsx`, `SigninPage.jsx`, `ForgotPage.jsx`, `ResetPage.jsx`, and `VerifyPage.jsx` *before* sending, and renders per-field errors from `error.flatten().fieldErrors`. The billing slice adds its own shared schemas in `shared/billing.js` and uses the same `validateBody`.
- **What I chose against, and why.** Two separate validations (a hand-rolled client check plus server checks) because drift between them is exactly the bug I wanted to rule out; sharing one schema file makes "the password rule changed" a one-line change. I also considered a full UI form library (react-hook-form + resolver); Zod alone plus a small `Field` component covered the needs without pulling in a dependency layer that would obscure the validation itself.

### Server-side sessions backed by Postgres (express-session + connect-pg-simple)

- **What it is.** After a successful sign-in or verification, the server stores `session.userId` in a row in the `session` table and hands the browser an opaque `httpOnly` session cookie. "Am I signed in?" is answered by looking the cookie up in the database, not by trusting anything in the cookie.
- **Why it is needed.** A cookie that contains the user's identity (a JWT, say) lets a theft of the cookie be a theft of the account, and there is no way to revoke it centrally short of accepting it forever. Signed-in-ness also has to survive the server restarting: an in-memory session store logs everyone out and, worse, forgets nothing important — but a cookie-only scheme cannot be killed when a password is reset. Storing sessions server-side is what lets `/reset` delete every session for a user in one statement.
- **How I implemented it.** `server/src/app.js:34-53` configures `express-session` with a `connect-pg-simple` store pointed at the `session` table, `rolling: true` for sliding expiry, a seven-day `maxAge`, and `httpOnly` so page scripts cannot read the cookie. `/signin`, `/verify`, and `/signout` only ever mutate `req.session.userId` (routes in `server/src/routes/auth.js`); `GET /api/me` in `server/src/app.js:63-96` is the single read point. The billing routes read the same `req.session.userId` for ownership.
- **What I chose against, and why.** JWTs for signed-in-ness: they are good for auth *between services* but the wrong tool for browser sessions — no server-side revocation, and every client is trusted to hold a value that is only worth stealing. And an in-memory store (the express-session default): it does not survive restart and offers no cross-process sharing, whereas making the database the store costs one indexed lookup per request and buys revocation for free.

### One-time, expiring tokens for verification and reset

- **What it is.** Every verification code and reset token is generated fresh, expires after a short TTL (15 and 30 minutes), and works exactly once: the transaction that accepts it also marks it `consumed_at` in the same atomic step.
- **Why it is needed.** A forever-valid reset link is a standing take-over token: forwarding an old email becomes a live credential indefinitely. A multi-use code makes replay trivial — "show me a code" succeeds twice, which has no legitimate use. Expiry bounds the window in which an attacker who has intercepted one email can act; single-use means the legitimate owner using their own link immediately nullifies any copy the attacker holds.
- **How I implemented it.** TTL is enforced in SQL, so an expired row is structurally rejected — `expires_at > now()` in every lookup (`/verify` and `/reset` in `server/src/routes/auth.js`). Single-use is enforced by writing `consumed_at = now()` inside the same `BEGIN … COMMIT` that verifies the email or changes the password, and `password_reset_tokens.token_hash` is globally unique. Reset additionally deletes all of the user's sessions in that transaction, so accepting the new password also revokes the attacker's cookies.
- **What I chose against, and why.** Expiring tokens by checking timestamps in application code rather than in the query; doing the checks in the SQL WHERE clause means a buggy code path that forgets the guard simply cannot over-accept, because the database itself refuses. I also considered a "verification link" instead of a six-digit code; I chose the code partly because the brief centres on code-based verification, and partly because a code typed into the app is less likely than an email link to be auto-clicked by link-preview robots, which consume single-use secrets.

### The resend cooldown

- **What it is.** A 60-second window after a code is sent before the same user can request another one, enforced on the client (a visible countdown) and, more importantly, on the server (in `/resend`, versus the code row's `created_at`).
- **Why it is needed.** Without a cooldown, the resend route is a free spam relay: call it in a loop and Mailpit (or, in production, a real provider) receives an unlimited stream of emails to one address; with a per-user limit but no cooldown, typo-driven double-clicks would also burn through the hourly budget instantly. A cooldown bounds blast-radius without asking the mail provider for help.
- **How I implemented it.** Server side, `resendCooldownMs` comes from config (default 60 s) and `/resend` compares the newest live code's `created_at` against `now()` (`server/src/routes/auth.js:155-161`), answering 429 with "wait N seconds". Client side, `VerifyPage.jsx` runs the same 60-second countdown so the button is disabled before the server even sees the request — the server is authoritative, the client merely avoids obvious mistakes.
- **What I chose against, and why.** Enforcing the cooldown only on the client: anyone can hit the API directly, so the countdown is cosmetic and the server rule is the real one. And a fixed delay-before-send rather than a cooldown — inserting the sleep into the request path would let an attacker tie up a connection per-IP for 60 seconds each, which is a cheap denial-of-service; a cooldown-on-request leaves the connection free.

### Section 6: What Went Wrong

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

### Section 7: What This Slice Does Not Handle

- **Multi-instance rate limiting.** The `express-rate-limit` defaults to an in-memory store: limits reset on restart and are per-process. Before real users touch it behind a load balancer, the limits must move to a shared store such as Redis, or the limits become a "one instance per attacker" speed bump rather than a global one.
- **Asynchronous email.** Sending happens inline in the request path (`sendEmail` awaited in `/signup`, `/resend`, `/forgot`). A slow or briefly down SMTP server turns sign-up and forgot-password into latency and occasional 500s, and there is no retry queue. Real-world mail needs a background worker with retries and dead-letter handling.
- **Breached-password and dictionary checks.** The password policy is length plus character classes. There is no check against known breached passwords (e.g. "Password1!" would pass), which is the single most effective cheap hardening step for credential-stuffing.
- **Multi-factor authentication.** Verification of the *email* is the only second step, and only at sign-up. No TOTP, hardware keys, or re-challenge on sensitive actions.
- **Account lockout.** The only throttle is per-IP rate limiting. There is no per-account counter, deliberately (attackers could lock real users out), but that means a stolen password is unimpeded until an IP limit triggers.
- **Change-password-while-signed-in.** There is no "update my password" page for a logged-in user — the flow only covers password reset from a forgotten/lost state.
- **CSRF tokens.** `sameSite: lax` mitigates top-level cross-site POSTs, and the API is JSON-only, but there is no explicit CSRF token. I would add a synchronizer token or double-submit cookie before treating the session as production-hardened.
- **Verification-code delivery at scale.** Codes and reset links rely on the caller's inbox being reachable; there is no SMS/fallback channel, no "code in the app" path, and no delivery analytics.
- **Deleted-session and token hygiene.** Sessions are removed explicitly on reset/sign-out; the email code and reset-token tables grow with history because consumed rows are not purged. A scheduled cleanup job would be required at scale (and a partial index keeps the active lookups fast meanwhile).
- **Out of scope vs. out of time.** Out of scope by design: OAuth/social providers, MFA, roles and permissions, admin tooling, real template rendering (and subscriptions, which are a separate slice documented in Part II). Out of time: none — each slice's own brief is fully implemented and verified; the gaps above are the honest list of what stands between this and a production-login system.

### Section 8: If I Built This Again

I would take email out of the request path from day one — a queue or background worker that the sign-up, resend, and forgot routes hand messages to and then instantly respond. The single most fragile moment in this whole slice is an awaited `sendMail()` blocking a password-reset or account-creation request; in development it is invisible, but the moment a real or degraded SMTP server is involved, the login delays, the 500s ("account created but we could not send the email"), and the code rows whose email never left become the slice's main source of operational pain. Everything else here — hashing at rest, uniform errors, database-backed sessions, single-use expiring tokens — would be rebuilt with the same decisions; the mail pipeline is the one thing I would not.

---

## Part II — Billing & Subscriptions

### Section 1: What This Is

This is the **subscription slice** of the same two processes: a user on the free plan can open a hosted checkout, pay, and be moved to the **Pro** plan monthly or yearly; a monthly Pro user can schedule an upgrade to yearly that is *charged now* at the full yearly price and applied only when the current month ends (no mid-cycle double-billing — the year starts exactly where the month leaves off); a yearly user can schedule a switch to monthly that the server applies when the billing period ends; anyone can cancel and keep Pro until the end of the period, optionally leaving a cancellation reason (a pending paid upgrade blocks cancellation until it applies, since a refund flow is out of scope). Every transition — checkout opened, payment verified, upgrade/downgrade scheduled, interval changed, cancellation scheduled, subscription ended, duplicate webhook ignored — is written once, immutably, to a `payment_events` ledger with an idempotency key, so a provider webhook delivered twice can never charge twice or grant twice.

The payment provider is deliberately **mocked in-process**: the "provider domain" is a checkout page served by this very server (`GET /pay/<reference>`) that signs and dispatches its own webhooks back to `/api/payments/webhook`. But the billing logic is the real thing — the webhook is the *only* thing that can change `users.plan`, every webhook is verified by an HMAC signature over the raw body, the "one subscription per user" invariant is structural in the schema, and money exists only as integer minor units (`amount_minor`). Swapping in Stripe / Recharge / Lemon Squeezy means replacing `server/src/billing/provider.js` — the checkout-URL and webhook-verify seam — while keeping that authority boundary intact. The slice reuses Part I's sessions and `lower(email)` account uniqueness without modification.

Deliberately **not** included: no live provider (cards are simulated, no SCA, no chargebacks or refunds), no dunning or retry ladder for failed renewals, no cancellation-reactivation, no plans-as-a-catalogue (prices are config constants), and no multi-instance scheduler or rate-limit store. All of those are named in Section 7.

### Section 2: How To Run It

Nothing about running changes: this slice lives in the same repo, the same Express server, the same React client, and the same Postgres database as Part I, and it starts with the same commands — `npm install`, `npm run setup`, `npm run db:migrate`, `npm run dev`. The billing migrations `20240102000000_billing` and `20240103000000_app_settings` are applied by `npm run db:migrate` just like the auth ones.

If you are upgrading a database that already ran the auth slice, existing users have no subscription row; the migration default gives them `plan = 'free'`, and the idempotent backfill `server/migrate-free-plan.mjs` (run from the repo root, once) re-asserts that invariant for every user without a subscription row. It is a safe no-op on subsequent runs.

**Environment variables specific to this slice** — plus the `config.rateLimit` group already documented in `.env.example`:

| Variable | Source | Default if missing |
|---|---|---|
| `SERVER_URL` | this server's origin, used to build the hosted-checkout links (`/pay/<ref>`) the mock provider serves | `http://localhost:3000` |
| `PAYMENT_WEBHOOK_SECRET` | you generate it, like `SESSION_SECRET` | a development-only string — must be set in production |
| `CHECKOUT_TTL_MS` | how long an opened checkout stays payable | `1800000` (30 min) |
| `PRICING_CURRENCY` | ISO currency for prices and charges (`server/src/config.js:18-24`) | `USD` |

The rate-limit group (`TRUST_PROXY`, `SIGNIN_WINDOW_MINUTES`, `SIGNIN_PER_ACCOUNT`, `SIGNIN_PER_IP`, `SIGNUP_*`, `FORGOT_*`, `RESEND_*`, `GENERIC_*`) applies unchanged; the billing-specific `checkoutLimiter` (10 per 15 min) is not yet configurable. Prices live in `config.pricing` (`server/src/config.js:18-24`): Pro is `1000` per month and `10000` per year, both integer minor units.

**To exercise the slice end to end:** sign in (Part I, Section 3), open <http://localhost:5173/plans>, choose Pro monthly, and on the mock checkout page (`Acme Payments — Test checkout`, simulated card `•••• 4242`, no real charge) press **Pay now**. You are returned to `/return?ref=…&status=success`; the page polls the session, confirms the payment, and the header badge flips to **Pro**. The same flow reaches the yearly price through "Billed yearly". On a monthly user, starting the yearly checkout charges the full yearly price now but leaves the monthly period running with the switch shown as scheduled on `/billing`; cancel asks for a reason and promises access until period end. You can watch the period boundary cross in seconds by driving the reaper directly (Section 3, step 7) — the tests (`server/test-reaper.mjs`, `server/test-reaper-downgrade.mjs`, `server/test-e2e.mjs`) do exactly that, and the screenshots live in `evidence/shots/`.

### Section 3: The Flow, Step By Step

**1. A free user opens the plans page.** `/plans`, `/billing`, and `/return` are protected routes (`client/src/App.jsx`), each wrapped in an `ErrorBoundary` so no failure can render a blank page. `PlansPage.jsx` loads `GET /api/billing/summary` (`server/src/routes/billing.js:128`), which returns `users.plan`, the current subscription (serialised), and the pricing — currency and integer prices straight from config. Each plan card derives its own action: already-current (disabled), subscribe, schedule a downgrade, or already-scheduled.

**2. Starting a checkout.** Subscribe posts `{interval: "month"|"year"}` to `POST /api/billing/checkout` (`server/src/routes/billing.js:43`), behind `checkoutLimiter` (10 per 15 min) and `validateBody(checkoutSchema)` (`shared/billing.js`). The route guards in order: the exact interval is already active (`existing: true`); you're yearly and asked for monthly via checkout (409 — that is the downgrade route's job); the same interval is already pending. Otherwise it reuses any still-open, unexpired checkout session of that interval, creating one when none exists: reference `cs_<uuid>`, `amount_minor` from config pricing, `expires_at = now + checkoutTtlMs` (30 min). Each new session writes a `checkout_initiated` ledger row keyed `checkout:<reference>`, so two concurrent opens for the same user+interval can't both write. The client redirects with `window.location.assign(url)` — a full top-level navigation to the provider domain, so back/refresh behave like a browser.

**3. The hosted checkout (the mock provider).** `GET /pay/<reference>` (`server/src/routes/mockProvider.js:95`) renders a minimal provider page: plan and price, "TEST MODE — no real card is charged", a simulated `•••• 4242`, and the reference. It is served with `Cache-Control: no-store`, and expired or unknown references get a plain "expired or not available" 404. Choosing **Pay now** or **Cancel / decline** POSTs `action=success|fail` (`mockProvider.js:112`), which dispatches the signed webhook to `POST /api/payments/webhook` and then 302s back to `returnUrl` → `/return?ref=…&status=success|failed`. The redirect is always last and always purely informational.

**4. The webhook carries the authority.** `POST /api/payments/webhook` (`server/src/routes/billing.js:224`) is the only place in the app that may change `users.plan`. It (a) re-derives the expected HMAC from the raw body and the `x-webhook-signature` header, rejecting anything that fails or is older than 5 minutes; (b) checks the idempotency key `webhook:<event_id>` — an event already processed is answered `{ok:true, duplicate:true}` and logged as `duplicate_webhook_ignored`, so a provider retry never double-charges; (c) loads the checkout session by `reference`; (d) for `payment.captured`: writes `payment_verified` (keyed), marks the session `completed`, and calls `fulfilPayment`; for `payment.failed`: marks the session `failed` and logs `payment_failed`; anything else is a 400. `fulfilPayment` (`billing.js:331`) either (i) grants Pro with a fresh period — upsert the one subscription row per user, set `users.plan = 'pro'`, log `subscription_fulfilled` — or (ii) handles the monthly→yearly upgrade (step 6).

**5. The return page settles the outcome.** `ReturnPage.jsx` reads `ref` (and `status` only as an initial hint) and polls `GET /api/billing/session/:ref` (`billing.js:110`) every 2 s, up to 30 attempts. States: *waiting* (spinner — "nothing has been charged until the provider confirms"), *payment confirmed* (`session.completed`, then `refresh()` re-reads `/api/me` so the header plan flips to Pro), *payment not completed* (`failed`), and *still waiting* (`expired`, or the poll budget exhausted — nothing was charged). Only the server session row decides: flipping `?status=success` in the URL changes nothing.

**6. Monthly → yearly: charged now, applied at period end.** For a monthly subscriber, a yearly checkout returns the full yearly price (not prorated). When the captured webhook arrives, `fulfilPayment` sees "month active + yearly paid": it sets `pending_interval = 'year'` on the still-monthly subscription, clears any pending cancellation, and logs `upgrade_scheduled` (with `appliedAt` = current `period_end`) and `subscription_fulfilled` (scheduled). The user stays Pro throughout at the monthly price until the year starts. `POST /api/billing/cancel` refuses (409) while that prepaid upgrade is pending — there is no refund flow to undo it (Section 7).

**7. Yearly → monthly, and cancellation: deferred to the reaper.** `POST /api/billing/downgrade` (`billing.js:146`) requires an active yearly subscription and sets `pending_interval = 'month'`, logging `downgrade_scheduled`. `POST /api/billing/cancel` (`billing.js:182`, optional reason) sets `cancel_at_period_end = true` (plus `cancelled_at`, `cancellation_reason`), logging `cancellation_scheduled`. Neither takes effect now: the reaper (`server/src/services/reaper.js`, a `setInterval` every 60 s, unref'd so it never holds the process open, first run at startup) loads every active subscription whose `period_end` has passed and applies, in order — `cancel_at_period_end` first (→ `status = 'cancelled'`, `users.plan = 'free'`, log `subscription_ended`), else `pending_interval` (→ switch interval and price, roll the period to `now + one interval`, log `interval_change_applied`). Open checkout sessions that outlived `expires_at` are swept to `expired` (log `checkout_expired`). The unit tests drive `runReaper(now)` directly by backdating `period_end`.

**8. The billing page and the ledger.** `BillingPage.jsx` renders the subscription — plan, interval, price, period start, renews/expires, scheduled switch, cancellation reason — straight off `GET /api/billing/summary`; the cancel flow collects a reason and confirms against `cancel_at_period_end`. Every one of the transitions above is also a row in `payment_events`, so the full story of any charge can be reconstructed end to end (Section 4, Section 5 — concept "The payment-event ledger").

### Section 4: The Data Model

### `users.plan` — the entitlement column

```sql
ALTER TABLE users ADD COLUMN plan TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users
    ADD CONSTRAINT users_plan_allowed CHECK (plan IN ('free', 'pro'));
```

- One column, two values. `users.plan` is the *single source of truth* that feature checks and the dashboard read; nothing reads "how much you pay" for entitlement, only "which plan you're on".
- It is written in exactly two places: the webhook's `fulfilPayment` (granting Pro) and the reaper (restoring free). No other route touches it, which is what keeps "you got Pro" meaningful.

### `subscriptions` — one row per user, terms live here

```sql
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
```

- `subscriptions_user_id_unique` makes the one-subscription-per-user invariant structural: `upsert` on `user_id` is safe because the database refuses a second row.
- The row carries the *terms* — interval, `amount_minor`, currency, period, `pending_interval`, `cancel_at_period_end` — while entitlement lives on `users.plan`. `pending_interval` is the deferred switch in either direction; `cancel_at_period_end` is the deferred cancel; the reaper reads both when `period_end` passes. All money is integer minor units with ISO `CHAR(3)` currency — no floats anywhere, so "what was charged" can never accumulate the classic `0.1 + 0.2` drift.

**Constraints that make invalid states impossible here:** the unique `user_id` forbids a second subscription per user; `amount_minor >= 0` rejects negative charges; both interval columns are enum-checked to exactly `month`/`year`; `period_end > period_start` means a period cannot be inserted backwards, and the FK cascades if the account is deleted.

### `checkout_sessions` — one open payment attempt

```sql
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
```

- `reference` (`cs_<uuid>`) is the single string the hosted checkout, the webhook, and the return-page poll all speak: the payer pays reference `X`, the provider's `payment.captured` names `X`, the server links them, and the client never needs to trust its own `?status=` query string.
- `status` moves `open → completed | failed | expired`; an `open` session whose `expires_at` passed is swept by the reaper (`checkout_expired` ledger row).

**Constraints that make invalid states impossible here:** `reference` is globally unique, so a provider event can only ever name one session; the interval/amount checks match the subscriptions table; FKs cascade from user deletion.

### `payment_events` — the ledger

```sql
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
```

- Every meaningful billing transition writes one immutable row: `checkout_initiated`, `payment_verified`, `subscription_fulfilled`, `upgrade_scheduled`, `downgrade_scheduled`, `interval_change_applied`, `cancellation_scheduled`, `subscription_ended`, `checkout_expired`, `payment_failed`, `duplicate_webhook_ignored`. `data` is a JSONB blob carrying the specifics — the applied-at date of a scheduled switch, cancellation reasons, the raw provider payload — so the ledger doubles as an audit trail any charge can be reconstructed from. **`event_key` is the idempotency anchor**: `checkout:<reference>` for initiations, `webhook:<event_id>` for verified webhooks. Because the column is unique, the *same* provider event delivered twice cannot write twice — the second delivery hits the unique violation and is logged as `duplicate_webhook_ignored` rather than charged again.

**Constraints that make invalid states impossible here:** `event_key` is unique, so a double-delivered event structurally cannot create a second charge or grant; `subscription_id` is `ON DELETE SET NULL` so the audit trail survives subscription deletion; the amount check rejects negative credits; FKs cascade from user deletion.

### Section 5: The Concepts

### Hosted checkout with a simulated provider

- **What it is.** Starting Pro creates a `checkout_sessions` row and returns a URL on the payment provider's domain. The payer is redirected there, pays (or aborts), and is returned to the app on `/return?ref=…&status=…`. In this repo the "provider domain" is the same server: `GET /pay/<reference>` (`server/src/routes/mockProvider.js:95`) renders a minimal hosted page that "charges" `•••• 4242`, and both outcomes POST a signed webhook back to `/api/payments/webhook`, then redirect.
- **Why it is needed.** The checkout must be a *hand-off*, not a form we own: card data never touches our server (which keeps the whole app out of PCI scope) and hosted pages are what real providers offer. A real integration swaps the page while the client code, the flow, and the endpoint contract stay identical.
- **How I implemented it.** `POST /api/billing/checkout` (`server/src/routes/billing.js:43`) computes the amount from `config.pricing`, reuses a still-open unexpired session of the same interval instead of stacking duplicates, and returns `{url, reference}`. The client redirects with `window.location.assign(url)` — a top-level navigation, so back/refresh land back in the app. `ReturnPage.jsx` polls every 2 s and shows confirmed / failed / "still waiting, nothing has been charged" states; an `ErrorBoundary` around every billing route guarantees no blank page regardless of what throws.
- **What I chose against, and why.** Implementing Stripe's in-host `Checkout` inline, or a full payment iframe: the brief calls for a reusable provider abstraction, and the mock captures the *authority boundary* (webhook is king) without needing credentials. Collecting card details on our own form would pull the app into PCI scope. Real cards, SCA, and refunds are named as out-of-scope in Section 7.

### Webhook signature verification (HMAC)

- **What it is.** Every provider webhook carries a signature header `x-webhook-signature: t=<ts>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<ts>.<rawBody>")`. The endpoint re-derives the expected HMAC from the raw body bytes and rejects anything that does not match within a 5-minute timestamp window (`server/src/billing/provider.js:20-46`).
- **Why it is needed.** If the endpoint trusted "a POST to /api/payments/webhook with a body", anyone could grant themselves Pro by POSTing `payment.captured`. A shared secret both parties know, but an attacker must guess, is what lets the server tell "really from the provider" from "curl invented this". Signing the *raw* body — not the parsed JSON — closes the classic whitespace/encoding trick, and the timestamp bounds replay of a captured signature.
- **How I implemented it.** `express.json` is configured with a `verify` callback that stashes the untouched bytes on `req.rawBody` (`server/src/app.js:15-23`); the webhook route verifies the raw body against the header with `timingSafeEqual` (constant-time compare), then parses. `PAYMENT_WEBHOOK_SECRET` is injected by config; `t` skew is capped at 5 minutes. The mock provider signs with the same function (`server/src/billing/provider.js:12-18`), so the whole loop exercises real cryptography.
- **What I chose against, and why.** Signature schemes that hash the parsed JSON — parse-order differences across providers make that fragile, and I control the exact raw bytes here. And no re-verification via an out-of-band "did you really deliver this?" fetch-back: for a self-hosted mock it is pure ceremony, and it is the kind of thing that must be per-provider in a real integration (Section 7).

### Idempotent webhook processing

- **What it is.** The same provider event delivered twice must produce the same end state and exactly one charge. The mechanism is a unique `event_key` column: `webhook:<event_id>` exists for at most one `payment_events` row.
- **Why it is needed.** Webhooks are delivered at-least-once by design — real providers retry on network blips and on 5xx, and a provider's own retry plus a manually replayed event is not rare. Without idempotency, a retried `payment.captured` double-applies: a subscription period that jumps twice, a plan grant that races its own updates, and two charges the customer can see.
- **How I implemented it.** The route first checks for the keyed row; if it exists it writes a (keyless) `duplicate_webhook_ignored` row and answers `{ok:true, duplicate:true}` — the provider sees success, no re-send happens, and nothing is charged or re-granted. A second guard refuses to re-fulfil a session that is no longer `open` (`billing.js:275-285`). `checkout_initiated` gets the same keyed treatment (`checkout:<reference>`), so two rapid checkout calls cannot double-open for the same user+interval.
- **What I chose against, and why.** "Last-writer-wins" updates with no ledger: too easy to type-check into a stale write and impossible to audit. A UUID-as-event-id dedupe table maintained by hand — the unique index *is* that table, in the same row as the fact being recorded, which keeps the "insert only if this happened once" atomic instead of a transaction dance.

### The authority boundary: redirects are never authority

- **What it is.** The split between "a redirect that informs" and "a webhook that authorises". The browser can be told anything (`/return?status=success`); the database can only be changed by a signed webhook.
- **Why it is needed.** Entitlement must never be payable by editing a URL. The return page and its query string live in attacker-influenced territory; treating them as truth turns "show the user a happy page" into "grant the user a plan". The `cs_<uuid>` reference is the only cross-domain token, and it is both server-generated and client-unforgeable.
- **How I implemented it.** The redirect carries `status` purely as a UX hint; the return page ignores it for entitlement and polls `GET /api/billing/session/:ref` (scoped to the signed-in user) until the real status arrives. `users.plan` is mutated only inside the webhook handler (`server/src/routes/billing.js:331`) and the reaper. Even a fully cURL-driven "success" return URL changes nothing.
- **What I chose against, and why.** Granting on the return redirect with a signed token in the query string ("`status=success&sig=...`"): it still routes grants through URLs the browser can leak in logs and referers, and the webhook already retries. And CSRF-style double-submit cookies for the provider callback — the webhook's HMAC is its own authentication, and there is no browser session in the call.

### Scheduled interval switch (monthly ↔ yearly)

- **What it is.** A monthly subscriber can move to yearly, and a yearly subscriber to monthly, but in both directions the switch is *deferred*: recorded as `pending_interval` and applied when the current billing period ends. A monthly→yearly upgrade additionally *charges now* — the provider captures the full yearly price at checkout, and the year starts exactly when the current month ends.
- **Why it is needed.** An immediate monthly→yearly switch either double-bills the overlap (you've already paid for the rest of this month) or forces a prorated credit for unused days — the classic "what did I pay and why" support question. Deferring the start to the period boundary keeps the maths trivial: one period pays the monthly price, the next period is the full year at the full yearly price, and there is never a fractional charge to explain. It also mirrors the existing yearly→monthly downgrade, which must wait for the next billing boundary anyway (retro-refunding the yearly discount mid-year would be a self-inflicted price gap).
- **How I implemented it.** `POST /api/billing/checkout` returns the full yearly price for a monthly→yearly request (no proration); the webhook sets `pending_interval = 'year'` on the still-monthly subscription, logs `upgrade_scheduled` with `appliedAt` = current `period_end`, and clears any pending cancellation (a paid upgrade is a new commitment). The reaper (`server/src/services/reaper.js`, every 60 s) later applies whichever `pending_interval` exists when `period_end` passes, switching interval + price and logging `interval_change_applied`. The yearly→monthly direction is the same field via `POST /api/billing/downgrade`, with `downgrade_scheduled` logged instead. Because a pending upgrade is *paid for*, `POST /api/billing/cancel` refuses it until it applies (`billing.js:190-197`); the refund flow is explicitly out of scope in Section 7. The E2E proof: monthly checkout captured 1000, the yearly upgrade checkout captured 10000 while the subscription stayed monthly/1000 with `pending_interval = 'year'`, and after the reaper crossed `period_end` the subscription read yearly/10000 with `interval_change_applied` logged.
- **What I chose against, and why.** Prorating the upgrade and starting the new year immediately: it requires trusting a pro-rata credit and re-reasoning a lower charge, and it overlaps the paid month with the new year. And allowing cancellation while a paid upgrade is pending: without a refund flow it would silently forfeit the prepaid year, so the API refuses it with a clear message rather than lying about the outcome.

### Period-end switches and cancel-at-period-end (the reaper)

- **What it is.** Interval switches in either direction (monthly→yearly and yearly→monthly) and cancellations are all *deferred*: `pending_interval` and `cancel_at_period_end` are stored on the subscription, and an in-process scheduler (`server/src/services/reaper.js`, every 60 s) closes them out when `period_end` passes — switching interval and price, or moving `status → cancelled` + `users.plan → free`, each with a ledger row. It also sweeps `open` checkout sessions that outlived `expires_at`.
- **Why it is needed.** Yearly is the discounted offer; letting a mid-year switch to monthly also retro-refund the discount would be a self-inflicted price gap, and the monthly→yearly direction should likewise not double-bill the overlap (Section "Scheduled interval switch"), so switches must wait for the next billing boundary. Cancellation that ended Pro instantly would be a bait-and-switch on "keep access until period end", which is the whole point of `cancel_at_period_end`. A one-row-per-user invariant keeps both semantics expressible as fields plus a timer.
- **How I implemented it.** The reaper is a `setInterval` (`.unref()`ed so it never holds the process open) that loads due subscriptions and checks `cancel_at_period_end` before `pending_interval` — a cancelled subscription cannot also switch. It is invoked at startup and on the interval; tests drive `runReaper(now)` directly by backdating `period_end`. `pending_interval` is reaper-agnostic to direction: the same code path applies a scheduled yearly upgrade (already paid for at checkout) and a scheduled monthly downgrade.
- **What I chose against, and why.** Immediate upgrade/downgrade/instant-revoke cancellation: all give the "swindled" user experience for no safety gain. And CRON-style external scheduling: it needs deployment plumbing; an in-process scheduler is honest for a single-node slice and easy to replace (Section 7 names the multi-instance caveat, the same one rate limiting has).

### Money as integer minor units

- **What it is.** `amount_minor` is an integer counting cents/100ths of `currency` (`1000` = `$10.00`); there is no `float` or fraction-carrying `numeric` anywhere in billing.
- **Why it is needed.** Floating-point money is the bug that quietly writes `29.999999999` into a charge or a credit. The moment two different renderings disagree about a cent, an auditor and a bank have a reason to talk to you.
- **How I implemented it.** The schema is `INTEGER` (`amount_minor >= 0`); pricing lives in `config.pricing` (`month: 1000`, `year: 10000`); period-price changes copy the quantised config values verbatim (no derived cents anywhere); comparison and math are integer-only. The client only ever formats by dividing by 100 for display (`client/src/lib/format.js`), and the mock provider page renders `toFixed(2)`.
- **What I chose against, and why.** `DECIMAL(10,2)` in Postgres: correct too, but Prisma's `Decimal` is awkward to pass through JSON and Zod, and plain integers are the least-bad common denominator for the wire format as well.

### The payment-event ledger

- **What it is.** Every billing decision, not just charges, is an immutable `payment_events` row: `checkout_initiated`, `payment_verified`, `subscription_fulfilled`, `upgrade_scheduled`, `downgrade_scheduled`, `interval_change_applied`, `cancellation_scheduled`, `subscription_ended`, `checkout_expired`, `payment_failed`, and `duplicate_webhook_ignored`.
- **Why it is needed.** Subscriptions have to be auditable: "why is this user Pro and when were they charged $100?" must be answerable from data, not from memory. Because every row carries `amount_minor`, `currency`, `provider_reference`, an optional `event_key`, and a `data` JSONB blob (raw provider payloads, applied-at dates, reasons), the ledger reconstructs a charge end to end.
- **How I implemented it.** One write helper (`server/src/services/billing.js:25-49`) is used by every transition; the `checkout:<reference>` / `webhook:<event_id>` keys make the ledger itself the idempotency mechanism (Section "Idempotent webhook processing"). The chronological list of `payment_events` after an E2E run is the natural proof: open → verified → fulfilled → upgrade scheduled → interval applied → downgrade scheduled → cancel scheduled → ended, with `duplicate_webhook_ignored` rows where the replay landed.
- **What I chose against, and why.** Writing nothing (or only the final subscription state): a plan flip with no history is a mystery with a page. A separate sidecar log or console output: not queryable and not transactional with the change. The unique `event_key` in the same row as the fact being recorded is the cheapest complete design.

### Section 6: What Went Wrong

**1. The webhook route was mounted under a prefix it could not be reached at.**
- **Symptom.** The mock provider's post-payment dispatch returned 404: `POST /api/payments/webhook` did not exist.
- **Investigation.** The billing router defined the route as `router.post("/api/payments/webhook", …)` but `app.use("/api/billing", billingRouter)` mounted the whole router under `/api/billing`, making the real path `/api/billing/api/payments/webhook`. The other billing routes (which began `/checkout`, `/cancel`…) were coincidentally fine because prefixes compose; the webhook path happened to hard-code `/api/payments/…`.
- **Cause.** Mixing "path written relative to mount point" and "path written as if absolute" in one router; `checkoutUrl`/`dispatchWebhook` pointed at the intended public path.
- **Fix.** Mounted the billing router at the root (`server/src/app.js:60`) and wrote every billing route with its full `/api/billing/…` path; the webhook now lives exactly at `/api/payments/webhook`. The E2E re-ran green from checkout through fulfilment.

**2. "No difference detected" vs. Prisma-7 `migrate diff` heuristics.**
- **Symptom.** `prisma migrate diff --from-empty --to-schema` printed an *empty* diff even for a schema with four new tables.
- **Investigation.** In Prisma 7 the empty→schema path outputs nothing unless the shadow DB config is coherent; the reliable drift check is `--from-config-datasource --to-schema <schema>`, which correctly reported "No difference detected" against the applied `20240102000000_billing` migration.
- **Cause.** Tool-behaviour quirk, not a schema gap — but it could mislead at exactly the moment you want to trust migrations.
- **Fix.** Standardised on the `--from-config-datasource` drift check and verified zero drift after `migrate deploy`; noted in the repo runbook so the trap is not re-hit.

### Section 7: What This Slice Does Not Handle

- **Billing is mocked, not a live provider.** The "provider" is a page served by this server that signs and dispatches its own webhooks. Real cards, SCA, refunds, chargebacks, plans-as-a-catalogue, and a provider dashboard are not implemented; swapping in Stripe/Recharge/Lemon Squeezy means replacing `server/src/billing/provider.js` (the checkout-URL / webhook-verify seam) with the real integration and keeping the authority boundary intact — and adding the per-provider out-of-band verification the mock deliberately skips.
- **No PCI scope — by construction.** Because no card data is touched (hosted mock checkout, no card storage), the app never enters PCI scope. That changes instantly with a real provider, and the choice of *hosted checkout* (as opposed to collecting card details on our own form) is what keeps even the future version out of most PCI requirements.
- **Single-instance scheduler and rate-limit store.** The reaper is an in-process `setInterval` and `express-rate-limit`'s store is in-memory: on a multi-replica deployment two instances could both process the same due subscription, and limits reset on restart. A real deployment wants a DB lock (`SELECT … FOR UPDATE SKIP LOCKED`) around reaper runs or a leader election, plus a shared (Redis) rate-limit store — the same caveat Part I Section 7 names for rate limiting.
- **No dunning / smart retry.** A failed recurring payment just lets the period lapse; there is no retry ladder, no "payment failed" email to the customer, and no grace-period choreography. The first of those matters the moment periods auto-renew for real money (in test mode periods simply roll on at the next captured payment).
- **No cancellation-reactivation or self-serve refunds.** Cancel is one-way (`cancel_at_period_end`); going back means opening a new checkout on a fresh period. A user who has paid for a scheduled yearly upgrade is deliberately blocked from cancelling *until it applies* (the API returns 409) precisely because there is no refund path — undoing that purchase would otherwise forfeit the prepaid year. There is no admin/customer refund flow, which a real business would want before long.
- **Pricing is code, not catalogue.** Prices live in `config.pricing`, not in the database. Fine for one plan, wrong for a real store; a production build would keep plans/prices in catalogue rows so price changes are data, not deploys.

### Section 8: If I Built This Again

I would write the provider boundary as an abstracted interface *first* — `createCheckout({plan, interval}) → url` and `verifyAndParseWebhook(rawBody, headers) → event` — even while mocking it, because the mock cannot exercise the messy reality of a real provider: at-least-once delivery, reordered events, out-of-band verification, and above all the same charge arriving under a *different* `event_id` on retry. The current idempotency design is exact for "same `event_id` twice"; a production provider also needs "same charge, new `event_id`" protection, and that dedupe wants to key on `provider_reference + amount` as a backstop, not just the event key.

The second change: wrap webhook fulfilment in one database transaction. Today `fulfilPayment` grants Pro, upserts the subscription, and writes several ledger rows as separate statements; idempotency makes a mid-way crash re-enterable safely, but a single `BEGIN … COMMIT` around plan-grant + subscription + ledger rows would make partial fulfilment structurally impossible rather than merely recoverable — the same lesson Part I drew from the `/verify` transaction. The reaper would get `SKIP LOCKED` from day one, prices would move to catalogue rows instead of config constants, and the "period rolls on with no charge" test-mode behaviour would be replaced by an explicit renewal path — so "if I built this again" starts from a clean seam, a transaction, and data-driven pricing.