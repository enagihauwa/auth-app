# DOCUMENTATION

## Section 1: What This Is

This is the **authentication slice** of an app: a user can create an account with an email and password, prove they own the email by entering a six-digit code sent to that address, sign in, see a protected dashboard, sign out, and — if they forget the password — receive a single-use reset link and choose a new one. Every password is stored as a bcrypt hash, every email code and reset token is stored only as its SHA-256 hash, sessions live in Postgres instead of in memory, and every sensitive endpoint is behind both schema validation and rate limits. The client is a small React app (`client/`) whose forms validate with the exact same Zod schemas the server uses, and the server is an Express API (`server/`) that talks to Postgres and sends email through a local SMTP server for development.

Deliberately **not** included: no OAuth or social login, no multi-factor authentication, no roles or permissions (the dashboard is a stub that proves the session works), no account lockout beyond IP rate limiting, no breached-password checks, no subscription/billing, and no async email queue. These are all real features a production auth system eventually needs, but each of them is a separate slice with its own decisions to make, and this slice stays small so the authentication decisions it does make are visible and reviewable. Notably it also ships no user-facing "change my password while logged in" flow and no graceful email-send pipeline; those gaps are named in Section 7.

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
- hashes the password with bcrypt, cost 12 (`server/src/routes/auth.js:57`);
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
- **How I implemented it.** `server/src/routes/auth.js:57` hashes at signup and `server/src/routes/auth.js:275` at password reset; `server/src/routes/auth.js:199-200` compares on sign-in. The cost factor 12 is the deliberate slowdown — it costs one honest login a few hundred milliseconds and costs an attacker the same time per guess. The database refuses mismatched formats outright:

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
- **How I implemented it.** Sign-up returns the identical message whether the INSERT succeeded or hit the `23505` unique violation (`server/src/routes/auth.js:67-74`). Forgot-password only branches internally and returns one constant message ("If that email has an account, a reset link is on its way.") (`server/src/routes/auth.js:226-249`). Sign-in uses one message for both unknown email and wrong password — `bcrypt.compare` runs even when the user does not exist, so the response *timing* does not leak either (`server/src/routes/auth.js:199-204`).
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
- **How I implemented it.** Server side, `resendCooldownMs` comes from config (default 60 s) and `/resend` compares the newest code's `created_at` against `now()` (`server/src/routes/auth.js:163-176`), answering 429 with "wait N seconds". Because issuing a new code consumes every older one in the same transaction, the newest row *is* the live one, so the query does not need to filter consumed/expired rows. Client side, `VerifyPage.jsx` runs the same 60-second countdown so the button is disabled before the server even sees the request — the server is authoritative, the client merely avoids obvious mistakes.
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

**5. Requesting a second verification code killed the server: `P2002 … one_active_per_user`.**
- **Symptom.** Any path that issued a new code for a user who already had a live one — sign-up of a stuck account, or `/api/auth/resend` after the cooldown — threw `PrismaClientKnownRequestError: Unique constraint failed on the constraint "email_verification_codes_one_active_per_user"`. Because no route caught it, the error escaped the request handler, the API process died, and the Vite proxy logged `ECONNRESET`/`ECONNREFUSED` until the watcher restarted — meanwhile Mailpit sat empty.
- **Investigation.** The partial unique index `email_verification_codes_one_active_per_user(user_id) WHERE consumed_at IS NULL` (Section 4) is deliberate: one user may have at most one *live* code. But the only `INSERT` to that table lived inside `createVerificationCode`, and the code that retires the old row lived in the `/resend` route — a `updateMany(… consumed_at = now() …)` in exactly one caller. Putting the invariant in the database and the enforcement in one route meant every *other* code-issuing path was a time bomb.
- **Cause.** A helper named `create` that did not describe its real contract ("create the *only* live code for this user"). The caller did the retiring; the moment a second caller appeared, the constraint — doing its job — surfaced as a crash instead of a handled transition.
- **Fix.** The invariant now lives with the insert. `createVerificationCode` runs one transaction: `updateMany({ where: { userId, consumedAt: null }, data: { consumedAt: now } })` then `create` (`server/src/services/tokens.js:16-33`), so the constraint can never be tripped regardless of caller. `createResetToken` got the same shape (`server/src/services/tokens.js:35-52`): reset tokens have no partial index so they could legally stack, but superseding an unconsumed token is the same single-use decision and one code path. I also wrapped every auth route handler in `try/catch (err) { next(err) }` so a future unhandled rejection surfaces as a 500 to that one request instead of crashing the process. `server/test-auth.mjs` pins all of it under `node --test`.

**6. Just-signed-in users were sometimes bounced back to sign-in: the response beat the session row.**
- **Symptom.** Intermittently, a fresh sign-in or verification redirected to the dashboard once and then `/api/me` answered 401 — the user was "signed in" and then, one refresh later, anonymous.
- **Investigation.** `connect-pg-simple` writes the session asynchronously: `req.session.userId = user.id` only mutates the in-memory `req.session`, and the Postgres row appears when `session.save()` resolves. `/signin` and `/verify` were calling `res.json` immediately, before the write completed, so a `GET /api/me` that raced the save could legitimately find no row and answer 401.
- **Cause.** Responding before the state change was durable — the classic write-behind response saying "done" while the effect is still in flight.
- **Fix.** A small `persistSession(req, res)` helper awaits `req.session.save()` before the response is sent, and both `/signin` and `/verify` use it (`server/src/routes/auth.js:28-38`, `:136`, `:215`). A successful "Signed in." now implies the session row already exists; the helper is also the single place to adjust if the store grows strict semantics.

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

---

# Part III — AI-Powered Receipt Extraction

## Section 1: What This Is

This is the **AI-processing slice** of the same app. A signed-in user uploads one or more receipt photos or PDFs; the server stores the bytes in a storage layer, records a processing job in Postgres, and puts that job on an in-process worker queue. A worker picks it up and calls **Google Gemini** through the **official `@google/genai` SDK**, asking the model to return an expense summary as structured JSON, shaped against a schema we provide and then validated a second time by **strict Zod schemas of our own**. The result is stored on the job row, and the client polls until the job is `DONE` or `FAILED`. A finished extract can be followed up with exactly one user-triggered action today — *"Summarise this expense"* — which spawns a child `EDIT` job that reuses the parent's result. Every knob in the slice is changeable: the model id, the concurrency cap, the per-call timeout, the retry count and backoff, the upload limits, and every rate limit are all in `server/src/config.js` or the processing group of `.env.example`. Either role ships a written system prompt with a one-line justification for every model parameter it sets.

Deliberately **not** included: no chatbot or free-text follow-up (the only follow-up is the one summarise button), no editing, sharing, exporting, or persisting of extracted expenses, no human-in-the-loop correction of the extraction, no spending dashboard or per-job token accounting, and no webhooks. The receipts themselves are never stored in the database — only a storage key is — and the model is only ever called with the bytes of the user's own upload plus their role text. There is no landing page and no new account machinery: this slice rides entirely on Assessment 1's sessions and `/api/me` guard.

## Section 2: How To Run It

Everything from Part I's "How To Run It" still applies — same databases, same users, same `npm run dev`. This slice adds one hand-operated secret and one new folder:

1. **Install the new dependencies** (from the repository root): `npm i --prefix server @google/genai multer` — already done in this repo, but a fresh clone needs it.
2. **Apply the migration.** The processing tables ship in a single migration, `server/prisma/migrations/20240104000000_processing`. It was written to be purely additive (new tables and columns only, nothing renamed or dropped), so `npm run db:migrate` (or `npm --prefix server prisma migrate deploy`) applies it cleanly over any existing history in this repository — it does not assume which earlier migrations were applied first.
3. **Paste the key by hand.** Create or open `server/.env` and add:
   ```
   GEMINI_API_KEY=your_key_from_Google_AI_Studio
   ```
   This is the one value a script must never write. The stack deliberately treats "no key configured" as a graceful first-class state: every job FAILS with the message *"paste your GEMINI_API_KEY into server/.env and retry"* rather than crashing, and the UI shows that error. `.env.example` carries a commented placeholder so the shape is documented without holding a secret.
4. **Run the tests** (`npm --prefix server test`): 15 tests that exercise the service layer with a fake provider, the worker's concurrency cap, storage round-trips, the recovery logic, and the HTTP routes (including 401/400/404/409/413 guarding) against a real Postgres.
5. **Start the app** as usual (`npm run dev`), sign in, and open `/upload`. Upload a receipt photo and watch the job go PENDING/PROCESSING/DONE; then press "Summarise this expense".

**New environment variables** (all optional; defaults shown):

| Variable | Default | What it does |
|---|---|---|
| `GEMINI_API_KEY` | empty | The Google AI Studio key for the model; empty ⇒ jobs FAIL gracefully |
| `PROCESSING_MODEL_ID` | `gemini-3.6-flash` | The model for both roles |
| `PROCESSING_CONCURRENCY` | `2` | Max simultaneous model calls in the worker |
| `PROCESSING_MODEL_TIMEOUT_MS` | `45000` | Abort a model call after this long |
| `PROCESSING_MAX_ATTEMPTS` | `3` | Retries per job before FAILED |
| `PROCESSING_RETRY_BACKOFF_MS` | `1500` | Sleep between retries |
| `PROCESSING_MAX_FILES` / `PROCESSING_MAX_FILE_BYTES` / `PROCESSING_ALLOWED_MIMES` | `6` / `5242880` / `image/jpeg,image/png,image/webp,application/pdf` | Upload envelope checks |
| `PROCESSING_UPLOAD_LIMIT*`, `PROCESSING_FOLLOWUP_LIMIT*`, `PROCESSING_RETRY_LIMIT*` | `10/15min`, `20/hour`, `5/15min` | Rate limits on the three cost-bearing endpoints |

## Section 3: The Flow, Step By Step

**1. The user uploads.** `client/src/pages/UploadPage.jsx` validates the file list client-side against the same ≤6 files, ≤5 MB, jpeg/png/webp/pdf rules, then `POST`s a `multipart/form-data` `files[]` to `/api/processing/upload` (`server/src/routes/processing.js:92`). `multer` runs in memory with `fileSize`/`files` caps configured from `config.processing.upload`; oversized returns 413, too many returns 400, and any unrecognised type returns 400 — all before a job exists.

**2. A job row is born.** The route creates `processing_jobs` (`kind: EXTRACT`, `status: PENDING`), then for each file: `newStorageKey()` (a namespaced key like `uploads/…`) → `put(key, buffer)` writes bytes to **disk** (`server/src/processing/storage.js`, the local stand-in for object storage) → inserts a `processing_files` row containing only the key and metadata, never the bytes.

**3. Enqueue and return.** `enqueue(job.id)` pushes the id onto the worker's FIFO queue and the route answers `201 {job:{id,status:PENDING}}` immediately. The request never touches the model — that is the whole point of the job/worker split.

**4. The worker claims it.** `server/src/processing/worker.js` pumps the queue while fewer than `config.processing.concurrency` (default 2) jobs are running. `runProcessingJob` (`server/src/processing/service.js:83`) claims the row atomically: `updateMany({ where: { id, status: PENDING }, data: { status: PROCESSING } })`; a claim count of zero means another worker already took it, and the job quietly returns. This is how duplicate claims are impossible.

**5. The model call.** `buildParts` reads the bytes back from storage and hands them to the provider as base64 `inlineData` parts. `server/src/processing/provider.js` wraps the `@google/genai` SDK: model from config (`gemini-3.6-flash`), the role's system prompt, `responseMimeType: "application/json"`, `responseSchema` from the mirror in `server/src/processing/schemas.js`, and the role's `temperature/topP/maxOutputTokens` from `server/src/processing/prompts.js`, with an `AbortController` timeout from `config.processing.modelTimeoutMs`.

**6. Validate, and feed failures back.** The raw payload is parsed with the role's **strict Zod schema**. If it fails, a `ValidationFailureError` records which fields were wrong and that list is appended to the user text of the next attempt ("You returned: … Fix exactly these issues…"), so the retry is not blind. Up to `PROCESSING_MAX_ATTEMPTS`, then the job goes `FAILED` with a human-readable `error`.

**7. The user sees a result.** `client/src/pages/JobViewPage.jsx` polls `GET /api/processing/jobs/:id` every 1200 ms until the status is `DONE` or `FAILED`, then renders the expense card (`ExpenseResult.jsx`) and, on `FAILED`, the exact `error` text from the job row with a Retry button, plus — when done — a "Summarise this expense" button.

**8. The one follow-up.** `POST /api/processing/jobs/:id/follow-up` (`server/src/routes/processing.js:155`) only accepts a `DONE` `EXTRACT` job owned by the caller (404 for anyone else's job, 409 if not finished, 400 if not an extract). It creates a child `EDIT` job with `parentId` and `input: {action:"summarise"}`, enqueues it, and the worker builds the parts from the parent's stored `result` JSON — no re-reading the image, a cheaper text-only call by design. A **Retry** endpoint (`/jobs/:id/retry`, 5/15 min) flips a `FAILED` job back to `PENDING` and requeues it.

## Section 4: The Data Model

### `processing_jobs` — one row per model-backed piece of work

```sql
CREATE TABLE processing_jobs (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('EXTRACT','EDIT')),
    status      TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING','PROCESSING','DONE','FAILED')),
    input       JSONB,
    result      JSONB,
    parent_id   BIGINT REFERENCES processing_jobs(id) ON DELETE SET NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX processing_jobs_user_id_idx   ON processing_jobs (user_id, status);
CREATE INDEX processing_jobs_parent_id_idx ON processing_jobs (parent_id);
```

- `kind`/`status` are constrained **enums in the database**, so an invalid state is un-writable, not just un-reachable. `EXTRACT` turns a batch of files into one expense; `EDIT` runs a follow-up on a parent's `result`.
- `input`/`result` are `JSONB` because store-and-surf the schema but let the model shape evolve without a DDL migration every week — the *decode* is strict (Zod) even though the *storage* is loose. `input` today only holds `{action}`; `result` holds the validated expense or the edit object.
- `parent_id` is a self-FK (with `ON DELETE SET NULL`) so an `EDIT` job points at its `EXTRACT` parent without either deleting the other.
- `attempts` and `error` make retries honest: the client can show "attempt 2 of 3" and the real reason for failure.

### `processing_files` — storage keys only

```sql
CREATE TABLE processing_files (
    id            BIGSERIAL PRIMARY KEY,
    job_id        BIGINT NOT NULL REFERENCES processing_jobs(id) ON DELETE CASCADE,
    storage_key   TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    BIGINT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- The only durable pointer to a receipt is `storage_key`. The bytes live in the storage layer (`server/src/storage/files/uploads/…` locally, gitignored); if the database leaks, there is no file; if the bucket leaks, there is no metadata. This is the classic object-storage arrangement, re-created for dev.
- `ON DELETE CASCADE` means deleting a job removes its file rows — the first step toward the orphan-cleanup job named in Section 7.
- `unique(storage_key)` forbids two jobs claiming the same bytes.

## Section 5: The Concepts

### Structured output: asking for a schema and validating it yourself

- **What it is.** The request tells Gemini `responseMimeType: "application/json"` plus a `responseSchema` (a JSON Schema describing `merchant`, `invoice_date`, `currency`, `total_minor`, line items, …), so the model returns *shaped* JSON instead of prose. Then, after the call, the exact same shape is re-checked with a **strict Zod schema** — a second, independent gate that the SDK does not provide.
- **Why it is needed.** Raw LLM output in an app's database is how `result.merchant.toUpperCase()` later turns into a 500. A JSON-schema request makes the model *try*, but models still hand back `total_minor` as a string, spell `""` differently from `null`, or drop fields. The responseSchema narrows the target; our own strict parser is the thing that guarantees what lands on the job row actually type-checks.
- **How I implemented it.** `schemas.js` defines the shape twice, generated side by side: a Zod schema (parsing gate, used by the service) and a mirrored JSON Schema (sent to Gemini). `prompts.js` maps each role to a schema and parameters; `service.js` runs `safeParse` and, on failure, feeds the Zod `issues` back as the next attempt's user text.
- **What I chose against, and why.** Trusting the model's JSON-schema adherence alone (a single point of failure) and a free-form prompt + flaky parse (the whole risk I want gone). The second gate costs one `safeParse` and removes the entire class of "model said yes, app exploded".

### The official SDK instead of raw HTTP

- **What it is.** `@google/genai` (Google's first-party TypeScript/JS SDK) is the only network client used; there is no hand-rolled `fetch` to `generativelanguage.googleapis.com`.
- **Why it is needed.** Raw HTTP means hand-maintaining auth headers, retry semantics, content-type plumbing, and every endpoint shape change; the SDK is the interface Google actually versions and tests. It also gives typed request options (`responseSchema`, `systemInstruction`, `abortSignal`) that a JSON blob would smuggle around as un-checked data.
- **How I implemented it.** One thin wrapper, `server/src/processing/provider.js`, sits between the service and the SDK so tests can substitute a fake. The wrapper owns key lookup, the `AbortController` timeout, the `generateContent` call, and mapping failures onto typed errors (`ProviderNotConfiguredError`, `ProviderTimeoutError`, `ProviderCallError`).
- **What I chose against, and why.** Raw `fetch`: every "features" thing (structured output, vision parts, system instructions) would be me reimplementing what the SDK already stabilises, for zero benefit. With an interface in front of it, the SDK choice is also the testable choice.

### System vs. user prompts, and defending every parameter

- **What it is.** The system prompt (per role: what the model is, what a receipt is, how to handle missing/violating data) is fixed by the app; the user prompt varies (empty for extraction, or the requested follow-up action, or appended validation feedback on retries). `prompts.js` also lists each model parameter with a one-line justification, e.g. `temperature: 0 // extract — the facts of a receipt are deterministic; 0 stops the model inventing prettier ones`.
- **Why it is needed.** Every tunable exists because it tunes *something*: `maxOutputTokens` bounds the bill and prevents runaway JSON; `temperature` trades determinism for creativity — appropriate differently for transcription (facts) vs. summarising (a nicer sentence is fine). Documenting the why next to the value keeps the knob from being twiddled into an unexplained "it works" state.
- **How I implemented it.** `ROLES` in `prompts.js` is the single source; `provider.js` copies `systemInstruction`, and the appropriate `temperature/topP/maxOutputTokens` per role.
- **What I chose against, and why.** One giant mega-prompt doing both jobs at once: extraction and summarisation have opposite temperature goals, so they are two roles sharing one model id, each with its own prompt and parameters. Separation also means the cheaper text-only follow-up never re-sends images.

### Jobs and workers: background work with the database as source of truth

- **What it is.** Model calls are not done in the request handler. A request creates a `PENDING` job row and returns; a worker later mutates that row `PROCESSING → DONE/FAILED`. Status is the database, not a promise held in memory.
- **Why it is needed.** Model latency counts in seconds, not milliseconds. Holding an HTTP connection open for the duration makes the client time out, ties up server threads, and turns a model outage into a page error. A job row means the client can bounce, the server can restart, and history survives: the user can refresh `/jobs/:id` any time.
- **How I implemented it.** Routes only ever `enqueue(job.id)`; `worker.js` runs `runProcessingJob`; `service.js` atomically claims (`updateMany` with status in the WHERE), processes, and persists; `recoverStaleJobs()` on boot marks anything left `PROCESSING` (from a crash) as `FAILED: "…the server restarted…"` and requeues `PENDING` rows.
- **What I chose against, and why.** Working in the request path (rejected above) and an in-memory wait-list only (loses state on restart — a job the client is polling would never finish). The DB-as-truth design is what makes "status" a durable, queryable fact.

### A queue with a concurrency cap

- **What it is.** A FIFO queue plus a ceiling: `enqueue` pushes job ids, and a pump starts a job only when `running < config.processing.concurrency`. The queue is plain in-memory array, one shared instance per process.
- **Why it is needed.** Six uploaded files = up to six model calls (plus their retries). Unbounded, that is a burst of parallel paid calls on one upload, and a flood of uploads would exhaust the API quota or the bank balance in one minute. The cap serialises the burst, and the FIFO order keeps a single user's jobs in upload order.
- **How I implemented it.** `worker.js:dequeueNext()` loops while capacity exists; each completed (or crashed) job decrements `running` and re-pumps. Concurrency is a config value so the cap is tuned without code changes.
- **What I chose against, and why.** No cap (rejected), a library queue (BullMQ + Redis) — a real deployment would justify it, but for a single-process slice a hand-rolled FIFO gives the same behaviour with a tenth of the machinery; the trade is named in Section 7. A concurrency *cap* rather than a throughput *rate-limiter* because the model provider is the scarce resource, not wall-clock time.

### Rate limiting as cost control

- **What it is.** The three endpoints that carry cost are limited per IP: `upload` 10 per 15 min, `follow-up` 20 per hour, `retry` 5 per 15 min (all configurable), reusing the same `express-rate-limit` helpers as Part I.
- **Why it is needed.** Part I's rate limits were about abuse (enumeration, lockout, spam). Here they are **cost control**: every upload is a paid model call with up to three attempts, so one careless client can spend real money. The limit turns "upload 10,000 receipts to try your luck" into "upload 10 in 15 minutes".
- **How I implemented it.** `server/src/rateLimit.js` exports the three limiter factories wired into `routes/processing.js`, with limits read from `config.processing.rateLimits`.
- **What I chose against, and why.** Per-user limits instead of per-IP: a shared-key account would then be weaponisable (any uploads under your key cost you); the in-memory store caveat from Part I applies unchanged.

### Objects on disk, keys in Postgres

- **What it is.** Uploaded bytes go to a storage layer (`storage.js`) with a `put/get/delete` interface; locally that is the gitignored `server/storage/` folder, and the file is reachable only by its unique key, which is the only thing stored in `processing_files`.
- **Why it is needed.** Storing binary blobs in Postgres bloats backups and every row read. The filesystem-as-object-store keeps the database queryable at a couple of rows per receipt, and the *interface* (`storage.js`) is the seam at which a real bucket would plug in with zero changes to jobs, routes, or tests.
- **How I implemented it.** `newStorageKey()` mints `uploads/<random>` names; the upload route `put`s bytes before the `processing_files` row; `buildParts` `get`s them back at processing time.
- **What I chose against, and why.** Storing bytes as `BYTEA` columns (bloat, no streaming, no CDN) and magic paths duplicated across the code (everything goes through the storage module, and `.gitignore` keeps dev blobs out of the repo — a real bucket would also never ship secrets).

### Timeouts with a defined fallback

- **What it is.** Every model call is wrapped in an `AbortController` armed with `config.processing.modelTimeoutMs` (45 s). On timeout the call throws `ProviderTimeoutError`; the service sleeps `retryBackoffMs` and retries up to `maxAttempts`; then the job is marked `FAILED` with "…timed out…", and the user can hit Retry.
- **Why it is needed.** A model call that hangs must not hang the worker forever: one stuck call occupies a concurrency slot, and a deadline keeps the whole pipeline responsive. Equally important, the failure *path* is defined, not emergent — the UI shows the error, Retry works, and no state is corrupt.
- **How I implemented it.** `provider.js` builds the controller and races SDK call against it; `service.js` classifies errors (timeout / not-configured / call failed) and decides retry-vs-fail by the same rules for each.
- **What I chose against, and why.** An infinite retry (bills forever; hides real failures) and failing the job on first error (a transient 5xx spike would be user-visible noise). Three attempts with backoff is the middle ground: resilient, bounded, honest.

### What one run costs, and what caps the total

- **What it is.** `gemini-3.6-flash` is priced per token (approx. $0.30 per million **input** tokens and $2.50 per million **output** tokens; images are billed as input tokens). A typical one-page receipt image with a ~500-token system prompt lands around 1,000–3,000 input tokens, and the JSON it returns is ~150–300 tokens — so an extract costs **on the order of $0.0001–$0.001** (a fraction of a US cent, dominated by output). The summarise follow-up is text-only and cheaper. The **free tier** of Google AI Studio also gives a daily allowance of `gemini-3.6-flash` calls, so for development the total is usually $0. (Confirm current per-token figures on the pricing page — this is an order-of-magnitude, not an invoice.)
- **Why it is needed.** "How much does this feature cost" is the question that should be answerable from the code; if it is not, nobody will be able to say whether the feature is profitable or a fire hazard.
- **How it is capped.** The levers are all here: per-endpoint rate limits (10 uploads/15 min), the concurrency cap (2 parallel calls), `maxAttempts` + backoff (a pathological receipt costs at most 3 calls), the free-tier daily quota, and `maxOutputTokens` per role. Nothing separately hard-stops spending if all knobs are loosened — that is the honest cap list, and it is mostly the request limits.
- **What I chose against, and why.** Instrumenting per-job token counts from the SDK response and a budget alarm. That is the *right* eventual addition (I named it in Section 8) but it was more surface than this slice needed when the rate limits already bound the worst case by three orders of magnitude.

## Section 6: What Went Wrong

**1. `prisma migrate dev` was unusable: P3014 shadow-database permission denied.**
- **Symptom.** `npm --prefix server exec -- prisma migrate dev --create-only` failed with `P3014: error: permission denied for database "…shadow…"` — the local role could not create databases, which `migrate dev`'s shadow database needs.
- **Fix.** I don't need `migrate dev` to generate a migration if I can produce the SQL myself. `prisma migrate diff --config server/prisma.config.ts --from-config-datasource --to-schema server/prisma/schema.prisma --script` diffs the live dev database (which already has all prior migrations) against the new schema and prints the delta. I reviewed that delta for safety and hand-wrote one deliberately **additive** migration — only `CREATE TABLE`s and one `ADD COLUMN`, nothing destructive — so it applies identically regardless of whether this branch lands on master or after the billing branch's history. Recorded it with `prisma migrate resolve --applied` and `migrate deploy` applied it to the dev DB. The additive rule is the real takeaway: for a repo whose branches carry competing migrations, "merges cleanly everywhere" is a property of the migration, not of luck.

**2. The `--from-migrations` and `--from-empty` diff variants silently produced nothing on Windows.**
- **Symptom.** `prisma migrate diff --from-migrations …` returned an empty diff even though the schema had clearly changed, and `--from-empty …` did the same; only `--from-config-datasource` produced real SQL.
- **Fix.** Stopped trying the broken variants and standardised on `--from-config-datasource` (diff live-DB vs. schema). Recorded here because "the diff is empty but I added tables!" is a silent trap that reads as "I forgot to save the file".

**3. PowerShell and npm ergonomics ate about as much time as the feature itself.**
- **Symptom.** `npm` sometimes did not run at all (PowerShell blocks `npm.ps1`; the command is `npm.cmd`); `npm exec prisma …` swallowed flags (answers come only with `--` or via `npm run` scripts); and a one-liner containing `@{u}` failed because PowerShell parses `@{u}` as a **hash-literal** rather than a brace-tagged argument.
- **Fix.** Portability notes in the wire protocol of my memory: use `npm.cmd`, use `npm run` scripts or explicit `--` for CLI flags, and quote any argument that looks like `@{…}`. Nothing about the application itself — a reminder that the shell is part of the engineering surface.

**4. The test suite tripped on the real database's constraints and the real auth flow.**
- **Symptom.** Three separate rounds of failures: (a) creating test users failed with `23514` — the `users.password_hash` bcrypt **check constraint** rejected my `"x".repeat(60)` placeholder (so I hash a real bcrypt at runtime); (b) the "retry with validation feedback" test never saw attempt 2, because my fake provider was being **re-constructed on every call**, resetting its call counter so it returned the bad output forever; (c) hand-forged session cookies were rejected, then `/api/auth/login` 404'd — the real route is `/api/auth/signin`.
- **Fix.** Hash passwords with the repo's `bcrypt`, construct the fake provider once per test, and obtain a session cookie the honest way: `POST /api/auth/signin` with known credentials, exactly as a browser would.
- **Lesson.** Each of these was a *test-harness* bug, but (a) and (c) were only possible because the harness bypassed real constraints; the moment tests treat production's invariants as part of the system under test, both bugs become features.

**5. A done job failed anyway: the model wrapped its JSON in a markdown code fence.**
- **Symptom.** A job with a visibly complete expense object in the response `Text` was marked `FAILED` with "The model returned something that is not valid JSON".
- **Investigation.** The provider did a bare `JSON.parse(text)`. Against the real API, some responses arrived as ```` ```json\n{…}\n``` ```` — perfectly valid markdown, not valid JSON input. `responseMimeType: "application/json"` makes that rare, but the seam where a typed response stops being byte-for-byte JSON is exactly where a flaky model/API pair fails.
- **Cause.** Trusting a JSON-typed response to *be* JSON. Models occasionally decorate even JSON-typed output with fences or a sentence of prose.
- **Fix.** `generateStructured` now trims the text, strips a leading ```` ```json ````/```` ``` ```` fence and any trailing ```` ``` ```` before `JSON.parse` (`server/src/processing/provider.js:102-109`). The failure path stays, unchanged: a response that is genuinely not JSON still fails loudly — the trim only stops the parser from being wrong about a well-formed one.

## Section 7: What This Slice Does Not Handle

- **Single-process worker.** The queue lives in the same Node process as the API, capped at `PROCESSING_CONCURRENCY`. Two server instances are two independent queues, each issuing their own model calls. A real deployment must run exactly one worker (or move the queue to Postgres/Redis); similarly, `recoverStaleJobs` runs only at boot, so a job stuck mid-`PROCESSING` on a long-lived single process is not rescued until restart. The honest flip side of the FIFO cap is that all of this is per-process.
- **No hard spend budget.** Rate limits + concurrency + free-tier quota bound the blast radius, but there is no daily budget alarm and no per-job token accounting, and a pathological receipt with three attempts costs three calls. Spending instrumentation belongs before real money flows.
- **The free tier caps you hard.** The Gemini free tier allows **20 API requests per day per project per model** (the API returns `429 RESOURCE_EXHAUSTED` past that, with an ~40s retry window — the error says "check your plan and billing details"). Every job attempt counts: a single upload with two retries is three requests. In practice this makes free-tier development okay for a handful of receipts a day; sustained usage needs either a paid tier or a different model. Our own smoke run against the real API exhausted the quota while verifying the integration, so a fresh account's first full day of testing may need to wait for the daily reset.
- **Files have no lifecycle.** Bytes written on upload stay on disk even after the job is `FAILED` or long finished; there is no orphan sweep, versioning, signed URLs, or retention policy. `storage.js` is the documented local stand-in — swap its `put/get/delete` for GCS/S3 and the rest of the slice does not change.
- **The model is a black box with no verification net.** Extraction is best-effort: nothing re-adds the line items to confirm they sum to `total_minor`, and a blurry or rotated receipt can fail or pass silently with wrong numbers. There is no human-in-the-loop correction UI.
- **PDFs and big images are best-effort.** Multi-page, very high-resolution PDFs can exceed the input window and fail; the 5 MB envelope is a size limit, not a resolution guarantee.
- **Exactly one follow-up (summarise).** No chat, no editing or saving extracted expenses, no export, no webhooks. The `EDIT` slot is a door, not a feature set.
- **The key is a human act.** `GEMINI_API_KEY` pasted by hand into `.env`; until then every job fails with a *clear* message, and there is no key versioning/rotation — changing the key is an edit + restart.

## Section 8: If I Built This Again

I would start with the worker **out of process and backed by a real queue** — a Postgres-polling lightweight worker or Redis-backed BullMQ — and only then the API. The in-process FIFO was the correct size for this slice, but the first production step is detaching model calls from the API's lifetime and making concurrency *"how many workers exist"* instead of *"a config number inside one process"*, which is also where the per-spend instrumentation belongs. Second, I would **schema-version the JSONB results** (a `schema_version` column from day one): the Zod schemas will evolve, and old `result` rows currently promise a shape they may not keep. Third, I would keep the two things that held up especially well — the provider **interface** that let me test the whole service against a fake model, and **structured output plus our own strict validation** as an explicit two-gate design; those two decisions are the difference between this slice being testable and being a demo. Last, files: into a real bucket with signed URLs and a retention rule from the start, because the storage seam is exactly where production surprises hide.