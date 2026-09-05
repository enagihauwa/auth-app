# DOCUMENTATION

## Section 1: What This Is

This is the **authentication slice** of an app: a user can create an account with an email and password, prove they own the email by entering a six-digit code sent to that address, sign in, see a protected dashboard, sign out, and — if they forget the password — receive a single-use reset link and choose a new one. Every password is stored as a bcrypt hash, every email code and reset token is stored only as its SHA-256 hash, sessions live in Postgres instead of in memory, and every sensitive endpoint is behind both schema validation and rate limits. The client is a small React app (`client/`) whose forms validate with the exact same Zod schemas the server uses, and the server is an Express API (`server/`) that talks to Postgres and sends email through a local SMTP server for development.

Deliberately **not** included: no OAuth or social login, no multi-factor authentication, no roles or permissions (the dashboard is a stub that proves the session works), no account lockout beyond IP rate limiting, no breached-password checks, no subscription/billing, and no async email queue. These are all real features a production auth system eventually needs, but each of them is a separate slice with its own decisions to make, and this slice stays small so the authentication decisions it does make are visible and reviewable. Notably it also ships no user-facing "change my password while logged in" flow and no graceful email-send pipeline; those gaps are named in Section 7.

## Section 2: How To Run It

Prerequisites: **Node.js 22.9 or later** (the dev scripts use `node --env-file-if-exists`), **PostgreSQL 13+**, and no other process on ports `3000`, `5173`, `1025`, or `8025`. From a fresh clone:

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

4. Run the migrations:

   ```
   npm run db:migrate
   ```

   This applies every `server/migrations/*.sql` that has not yet been recorded in the `schema_migrations` table, in filename order, each in its own transaction. Re-running it is safe; it skips already-applied files.

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
- **How I implemented it.** Sign-up returns the identical message whether the INSERT succeeded or hit the `23505` unique violation (`server/src/routes/auth.js:56-61`). Forgot-password only branches internally and returns one constant message ("If that email has an account, a reset link is on its way.") (`server/src/routes/auth.js:211-233`). Sign-in uses one message for both unknown email and wrong password — `bcrypt.compare` runs even when the user does not exist, so the response *timing* does not leak either (`server/src/routes/auth.js:185-192`).
- **What I chose against, and why.** Returning distinct errors ("This email is not registered") because the richer UX is the exact mechanism enumeration exploits; with rate limits it would still be a mail-based oracle across many IPs. I also considered rate-limiting strictly per-account; the catch there is that gives the attacker a per-account lockout ability, which is its own abuse, so the accepted outcome is vaguer errors plus per-IP limits.

### Rate limiting

- **What it is.** Throwing away requests that exceed a per-IP budget inside a time window. This app has per-endpoint limits on signup, sign-in, forgot, and resend, plus one broad limit covering everything.
- **Why it is needed.** Without it, sign-in is an unthrottled guessing machine: an attacker can throw tens of thousands of guesses a minute, and each attempt costs a bcrypt compare plus a database query on my server. Similarly, `/forgot` and `/signup` become the enumeration oracle from the previous concept (millions of emails per day if unthrottled), and `/resend` becomes a spam cannon against arbitrary inboxes. Rate limits cap the *rate* of all of these.
- **How I implemented it.** `server/src/rateLimit.js` builds declarative limiters from `express-rate-limit`, mounted per route (`signinLimiter` 10/15 min, `signupLimiter`, `forgotLimiter`, `resendLimiter` 5/hour each) and one `genericLimiter` on the whole API (180/hour) in `server/src/app.js:11`. They return the standard headers so a well-behaved client can back off.
- **What I chose against, and why.** An in-process store class is the honest default here — but note the consequences: everything resets when the server restarts, and it does not count across multiple server instances. A Redis store becomes mandatory the moment the app runs on more than one process, and that is a deployment task, not a correctness one for a single-node slice, so I accepted the limitation and named it in Section 7. I also chose IP-based identity over account-based, deliberately, to stop attackers from weaponising prolonged lockouts of real users.

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
- **Out of scope vs. out of time.** Out of scope by design: OAuth/social providers, MFA, roles and permissions, billing, admin tooling, real template rendering. Out of time: none — the slice's own brief is fully implemented and verified; the gaps above are the honest list of what stands between this and a production-login system.

## Section 8: If I Built This Again

I would take email out of the request path from day one — a queue or background worker that the sign-up, resend, and forgot routes hand messages to and then instantly respond. The single most fragile moment in this whole slice is an awaited `sendMail()` blocking a password-reset or account-creation request; in development it is invisible, but the moment a real or degraded SMTP server is involved, the login delays, the 500s ("account created but we could not send the email"), and the code rows whose email never left become the slice's main source of operational pain. Everything else here — hashing at rest, uniform errors, database-backed sessions, single-use expiring tokens — would be rebuilt with the same decisions; the mail pipeline is the one thing I would not.