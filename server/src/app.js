import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import { pool } from "./db.js";
import { config, isProduction } from "./config.js";
import authRouter from "./routes/auth.js";
import { genericLimiter } from "./rateLimit.js";

const app = express();
app.use(express.json());
app.use(genericLimiter);

app.set("trust proxy", 1);

app.use(
  session({
    store: new (pgSession(session))({
      pool,
      tableName: "session",
    }),
    name: "sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  })
);

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.use("/api/auth", authRouter);

app.get("/api/me", (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not signed in." });
  }
  pool
    .query(
      "SELECT id, name, email, email_verified_at FROM users WHERE id = $1",
      [req.session.userId]
    )
    .then(({ rows }) => {
      if (rows.length === 0) {
        return req.session.destroy(() => res.status(401).json({ error: "Not signed in." }));
      }
      res.json({ user: rows[0] });
    })
    .catch((err) => {
      console.error("GET /api/me failed", err);
      res.status(500).json({ error: "Something went wrong." });
    });
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

export default app;