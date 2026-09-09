import express from "express";
import session from "express-session";
import pgSession from "connect-pg-simple";
import pg from "pg";
import { prisma } from "./db.js";
import { config, isProduction } from "./config.js";
import authRouter from "./routes/auth.js";
import billingRouter from "./routes/billing.js";
import mockProviderRouter from "./routes/mockProvider.js";
import { genericLimiter } from "./rateLimit.js";
import { startReaper } from "./services/reaper.js";

const app = express();

app.use(
  express.json({
    // Capture the exact request body so webhook signatures can be verified
    // against the raw bytes, before any parsing.
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: false }));
app.use(genericLimiter);

app.set("trust proxy", config.trustProxy);

const sessionPool = new pg.Pool({ connectionString: config.databaseUrl });
sessionPool.on("error", (err) => {
  console.error("Unexpected error on idle client", err);
});

app.use(
  session({
    store: new (pgSession(session))({
      pool: sessionPool,
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
app.use(billingRouter);
app.use("/pay", mockProviderRouter);

app.get("/api/me", async (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Not signed in." });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId },
      select: {
        id: true,
        name: true,
        email: true,
        emailVerifiedAt: true,
        createdAt: true,
        plan: true,
      },
    });
    if (!user) {
      return req.session.destroy(() => res.status(401).json({ error: "Not signed in." }));
    }
    res.json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan,
        email_verified_at: user.emailVerifiedAt,
        created_at: user.createdAt,
      },
    });
  } catch (err) {
    console.error("GET /api/me failed", err);
    res.status(500).json({ error: "Something went wrong." });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong." });
});

startReaper();

export default app;