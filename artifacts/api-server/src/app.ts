import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import path from "path";
import router from "./routes";
import { logger } from "./lib/logger";
import { pool } from "@workspace/db";

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

app.use(
  cors({
    origin: true,
    credentials: true,
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
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    },
  })
);

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve uploaded files (avatars, banners)
app.use("/api/uploads", express.static(path.join(process.cwd(), "uploads")));

app.use("/api", router);

export default app;
