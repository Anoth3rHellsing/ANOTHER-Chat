import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import path from "path";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";
import { authRateLimit, inviteRateLimit, messageRateLimit } from "./middleware/rate-limit";
import { finalErrorHandler } from "./middleware/errors";

const PgSession = ConnectPgSimple(session);

// Ensure the sessions table exists without relying on connect-pg-simple's
// file-based SQL loader (which breaks when bundled by esbuild).
// Each statement is run separately to avoid dollar-quoting issues with pg.
export async function ensureSessionTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS "sessions" (
       "sid"    VARCHAR      NOT NULL COLLATE "default",
       "sess"   JSON         NOT NULL,
       "expire" TIMESTAMP(6) NOT NULL
     )`
  );
  // Add PK — error code 42710 = duplicate_object (already exists), safe to ignore
  try {
    await pool.query(
      `ALTER TABLE "sessions"
         ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE`
    );
  } catch (err: any) {
    // 42710 = duplicate_object (constraint name already exists)
    // 42P16 = invalid_table_definition (table already has a primary key)
    if (err.code !== "42710" && err.code !== "42P16") throw err;
  }
  await pool.query(
    `CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "sessions" ("expire")`
  );
  logger.info("Session table ready");
}

// createTableIfMissing is intentionally NOT used — it reads table.sql from the
// package directory at runtime, which esbuild does not bundle.
const sessionStore = new PgSession({
  pool,
  tableName: "sessions",
});

// Expose session store globally for WebSocket auth
(globalThis as any).__sessionStore = sessionStore;

const app: Express = express();
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// The API does not serve browser documents, so Helmet's CSP is intentionally
// disabled. Uploads below set their own stricter, route-specific headers.
app.use(helmet({ contentSecurityPolicy: false }));

const configuredOrigin = process.env.APP_URL;
let appOrigin: string | undefined;
if (configuredOrigin) {
  try {
    const parsed = new URL(configuredOrigin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.pathname !== "/" && parsed.pathname !== "" || parsed.search || parsed.hash) {
      throw new Error("APP_URL must be an http(s) origin without a path, query, or fragment");
    }
    appOrigin = parsed.origin;
  } catch (err) {
    throw new Error(`Malformed APP_URL: ${configuredOrigin}. Expected an http(s) origin.`);
  }
} else {
  logger.warn("APP_URL is not configured; production browser CORS requests will be rejected");
}

function isLocalDevelopmentOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return ["http:", "https:"].includes(parsed.protocol) &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") &&
      (!parsed.port || (Number(parsed.port) >= 1 && Number(parsed.port) <= 65535));
  } catch {
    return false;
  }
}

app.use(
  cors((req, callback) => {
    const origin = req.get("origin");

    // Non-browser clients (curl, server-to-server) have no Origin header.
    if (!origin) {
      callback(null, { origin: true, credentials: true });
      return;
    }

    let parsedOrigin: URL | undefined;
    try { parsedOrigin = new URL(origin); } catch { /* rejected below */ }

    const requestHost = req.get("host");
    const isSameOrigin = parsedOrigin !== undefined &&
      requestHost !== undefined &&
      parsedOrigin.protocol === `${req.protocol}:` &&
      parsedOrigin.host === requestHost;
    const allowed = parsedOrigin?.origin === appOrigin ||
      isSameOrigin ||
      (process.env.NODE_ENV !== "production" && isLocalDevelopmentOrigin(origin));

    if (allowed) {
      callback(null, { origin: parsedOrigin?.origin, credentials: true });
      return;
    }

    const error = new Error("Origin not allowed") as Error & { status: number };
    error.status = 403;
    callback(error);
  })
);

app.use(
  session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET ?? "dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: "lax",
    },
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.post("/api/auth/login", authRateLimit);
app.post("/api/auth/register", authRateLimit);
app.post("/api/auth/register", inviteRateLimit);
app.post("/api/servers/join-by-invite", inviteRateLimit);
app.post("/api/channels/:channelId/messages", messageRateLimit);
app.post("/api/dms/:userId", messageRateLimit);

// Serve uploaded files — hardened headers to prevent XSS
app.use("/api/uploads", (req, res, next) => {
  // Never sniff content type
  res.setHeader("X-Content-Type-Options", "nosniff");
  // Isolate from app origin
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  // Force attachment download for everything except known safe inline types
  const ext = (req.path.split(".").pop() ?? "").toLowerCase();
  const inlineAllowed = new Set(["jpg", "jpeg", "png", "gif", "webp", "mp4", "webm", "ogg"]);
  if (!inlineAllowed.has(ext)) {
    res.setHeader("Content-Disposition", "attachment");
  }
  next();
}, express.static(path.join(process.cwd(), "uploads")));

app.use("/api", router);
app.use(finalErrorHandler);

export default app;
