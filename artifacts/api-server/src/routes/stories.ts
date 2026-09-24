import { Router, type IRouter, type Request, type RequestHandler } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { eq, and, gt, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const MAX_ACTIVE_STORIES = 10;
const STORY_LOCK_NAMESPACE = 72841;
const STORY_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_STORY_CLEANUP_GRACE_MS = 60 * 60 * 1000;
const STORY_CLEANUP_BATCH_SIZE = 100;
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `story-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB for video

function getBaseUrl() {
  return process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "";
}

// Raw SQL helpers (stories table is not in drizzle schema)
async function rawQuery(text: string, values?: any[]) {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try {
    return await client.query(text, values);
  } finally {
    client.release();
  }
}

async function insertStoryIfUnderLimit(
  userId: number,
  mediaUrl: string,
  mediaType: string,
): Promise<{ story: any | null; limitReached: boolean }> {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize simultaneous uploads by the same account so parallel requests
    // cannot race past the active-story limit.
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [STORY_LOCK_NAMESPACE, userId]);
    const count = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM stories WHERE user_id = $1 AND expires_at > NOW()",
      [userId],
    );
    if (Number(count.rows[0].count) >= MAX_ACTIVE_STORIES) {
      await client.query("ROLLBACK");
      return { story: null, limitReached: true };
    }
    const inserted = await client.query(
      `INSERT INTO stories (user_id, media_url, media_type) VALUES ($1, $2, $3) RETURNING *`,
      [userId, mediaUrl, mediaType],
    );
    await client.query("COMMIT");
    return { story: inserted.rows[0], limitReached: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function removeUploadedStory(req: Request, filePath: string): Promise<void> {
  try {
    await fs.promises.unlink(filePath);
  } catch (error) {
    req.log.error({ err: error }, "Unable to remove rejected story upload");
  }
}

function storyFilenameFromUrl(mediaUrl: string): string | null {
  try {
    const pathname = new URL(mediaUrl, "http://story-media.invalid").pathname;
    const match = /^\/api\/uploads\/(story-\d+-[a-z0-9]+\.[a-z0-9]+)$/i.exec(pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function storyFilePath(filename: string): string | null {
  if (!/^story-\d+-[a-z0-9]+\.[a-z0-9]+$/i.test(filename)) return null;
  const root = path.resolve(uploadDir);
  const filePath = path.resolve(root, filename);
  return path.dirname(filePath) === root ? filePath : null;
}

/**
 * Story uploads share the public uploads directory with profile and message
 * media. Intercept story-prefixed filenames before express.static so a copied
 * URL can only serve a live story to an authenticated user. The active stories
 * feed is intentionally global to authenticated users, so authentication is
 * the existing viewer-entitlement rule.
 */
export const authorizeStoryMedia: RequestHandler = async (req, res, next): Promise<void> => {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(req.path);
  } catch {
    res.sendStatus(404);
    return;
  }

  const filename = path.basename(decodedPath);
  if (!filename.toLowerCase().startsWith("story-")) {
    next();
    return;
  }
  if (!req.session.userId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  const filePath = storyFilePath(filename);
  if (!filePath) {
    res.sendStatus(404);
    return;
  }

  try {
    const result = await rawQuery(
      `SELECT id
       FROM stories
       WHERE RIGHT(media_url, CHAR_LENGTH($1)) = $1
         AND expires_at > NOW()
       LIMIT 1`,
      [`/api/uploads/${filename}`],
    );
    if (!result.rows[0]) {
      res.sendStatus(404);
      return;
    }

    // Never let browser or intermediary caches outlive the database check.
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Pragma", "no-cache");
    res.sendFile(filePath, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    next(error);
  }
};

function getStoryCleanupGraceMs(): number {
  const override = Number(process.env.STORY_CLEANUP_GRACE_MS);
  return Number.isFinite(override) && override >= 0
    ? override
    : DEFAULT_STORY_CLEANUP_GRACE_MS;
}

function getStoryCleanupIntervalMs(): number {
  const override = Number(process.env.STORY_CLEANUP_INTERVAL_MS);
  return Number.isSafeInteger(override) && override >= 1_000 && override <= 24 * 60 * 60 * 1000
    ? override
    : STORY_CLEANUP_INTERVAL_MS;
}

/**
 * Delete only stories that still satisfy the expired-with-grace predicate
 * while locked. The DELETE is the final condition check; the story row's
 * FK cascade removes views in the same transaction. The file is removed
 * before commit so an unlink error rolls the row delete back and is retried.
 */
export async function cleanupExpiredStories(): Promise<number> {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  const graceMs = getStoryCleanupGraceMs();
  let deletedCount = 0;

  try {
    const candidates = await client.query<{
      id: number;
    }>(
      `SELECT s.id
       FROM stories s
       WHERE s.expires_at <= NOW() - ($1 * INTERVAL '1 millisecond')
       ORDER BY s.expires_at, s.id
       LIMIT $2`,
      [graceMs, STORY_CLEANUP_BATCH_SIZE],
    );

    for (const candidate of candidates.rows) {
      await client.query("BEGIN");
      try {
        const current = await client.query<{
          media_url: string;
          view_count: string;
        }>(
          `SELECT s.media_url,
                  (SELECT COUNT(*)::text FROM story_views sv WHERE sv.story_id = s.id) AS view_count
           FROM stories s
           WHERE s.id = $1
             AND s.expires_at <= NOW() - ($2 * INTERVAL '1 millisecond')
           FOR UPDATE OF s`,
          [candidate.id, graceMs],
        );
        if (!current.rows[0]) {
          await client.query("COMMIT");
          continue;
        }

        const { media_url: mediaUrl, view_count: viewCount } = current.rows[0];
        // Recheck expiry and URL identity atomically immediately before unlink.
        const deleted = await client.query<{ id: number }>(
          `DELETE FROM stories
           WHERE id = $1
             AND media_url = $2
             AND expires_at <= NOW() - ($3 * INTERVAL '1 millisecond')
           RETURNING id`,
          [candidate.id, mediaUrl, graceMs],
        );
        if (!deleted.rowCount) {
          await client.query("COMMIT");
          continue;
        }

        const filename = storyFilenameFromUrl(mediaUrl);
        const filePath = filename ? storyFilePath(filename) : null;
        if (filePath) {
          try {
            await fs.promises.unlink(filePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        } else {
          logger.warn({ storyId: candidate.id }, "Expired story had an invalid media URL; database row removed without touching disk");
        }
        await client.query("COMMIT");
        deletedCount++;
        logger.info({
          storyId: candidate.id,
          file: filename,
          views: Number(viewCount),
        }, "Expired story and associated views cleaned up");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        logger.warn({ err: error, storyId: candidate.id }, "Failed to clean expired story");
      }
    }
    return deletedCount;
  } finally {
    client.release();
  }
}

// Do not run destructive retention work against the shared development DB
// just because the API workflow starts. Production runs by default; isolated
// integration tests can opt in explicitly.
const storyCleanupEnabled =
  process.env.NODE_ENV === "production" ||
  process.env.STORY_CLEANUP_ENABLED === "true";
if (storyCleanupEnabled) {
  const runCleanup = () => {
    void cleanupExpiredStories().catch((error) => {
      logger.warn({ err: error }, "Expired story cleanup failed");
    });
  };
  const interval = setInterval(runCleanup, getStoryCleanupIntervalMs());
  interval.unref();
  runCleanup();
}

// GET /stories — get active stories grouped by user
router.get("/stories", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const result = await rawQuery(`
      SELECT s.id, s.user_id, s.media_url, s.media_type, s.expires_at, s.created_at,
             u.username, u.display_name, u.avatar_url,
             EXISTS(SELECT 1 FROM story_views sv WHERE sv.story_id = s.id AND sv.viewer_id = $1) AS viewed
      FROM stories s
      JOIN users u ON u.id = s.user_id
      WHERE s.expires_at > NOW()
      ORDER BY s.user_id, s.created_at ASC, s.id ASC
    `, [userId]);

    // Group by user
    const grouped: Record<number, any> = {};
    for (const row of result.rows) {
      if (!grouped[row.user_id]) {
        grouped[row.user_id] = {
          userId: row.user_id,
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
          stories: [],
          hasUnviewed: false,
        };
      }
      const story = {
        id: row.id,
        mediaUrl: row.media_url,
        mediaType: row.media_type,
        expiresAt: row.expires_at,
        createdAt: row.created_at,
        viewed: row.viewed,
      };
      grouped[row.user_id].stories.push(story);
      if (!row.viewed) grouped[row.user_id].hasUnviewed = true;
    }

    // Sort: current user first (if they have stories), then unviewed, then viewed
    const groups = Object.values(grouped).sort((a: any, b: any) => {
      if (a.userId === userId) return -1;
      if (b.userId === userId) return 1;
      if (a.hasUnviewed && !b.hasUnviewed) return -1;
      if (!a.hasUnviewed && b.hasUnviewed) return 1;
      return 0;
    });

    res.json(groups);
});

// POST /stories — upload a new story
router.post("/stories", requireAuth, upload.single("file"), async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    if (!req.file) { res.status(400).json({ error: "No se recibió ningún archivo" }); return; }

    const baseUrl = getBaseUrl();
    const mediaUrl = `${baseUrl}/api/uploads/${req.file.filename}`;
    const mediaType = req.file.mimetype.startsWith("video/") ? "video" : "image";

    try {
      const result = await insertStoryIfUnderLimit(userId, mediaUrl, mediaType);
      if (result.limitReached) {
        await removeUploadedStory(req, req.file.path);
        res.status(429).json({
          error: `Ya tienes el máximo de ${MAX_ACTIVE_STORIES} historias activas. Espera a que caduque alguna antes de publicar otra.`,
        });
        return;
      }
      res.status(201).json(result.story);
    } catch (error) {
      await removeUploadedStory(req, req.file.path);
      throw error;
    }
});

// POST /stories/:storyId/view — mark a story as viewed
router.post("/stories/:storyId/view", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const storyId = parseInt(req.params.storyId as string, 10);
    await rawQuery(
      `INSERT INTO story_views (story_id, viewer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [storyId, userId]
    );
    res.sendStatus(204);
});

// GET /stories/:storyId/viewers — get viewer list (author only)
router.get("/stories/:storyId/viewers", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const storyId = parseInt(req.params.storyId as string, 10);

    const storyRes = await rawQuery(`SELECT * FROM stories WHERE id = $1`, [storyId]);
    if (!storyRes.rows[0]) { res.status(404).json({ error: "Historia no encontrada" }); return; }
    if (storyRes.rows[0].user_id !== userId) { res.status(403).json({ error: "Sin acceso" }); return; }

    const result = await rawQuery(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, sv.viewed_at
      FROM story_views sv
      JOIN users u ON u.id = sv.viewer_id
      WHERE sv.story_id = $1
      ORDER BY sv.viewed_at DESC
    `, [storyId]);

    res.json(result.rows.map(r => ({
      userId: r.id,
      username: r.username,
      displayName: r.display_name,
      avatarUrl: r.avatar_url,
      viewedAt: r.viewed_at,
    })));
});

// DELETE /stories/:storyId — delete your own story
router.delete("/stories/:storyId", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const storyId = parseInt(req.params.storyId as string, 10);
    const result = await rawQuery(
      `DELETE FROM stories WHERE id = $1 AND user_id = $2 RETURNING id`,
      [storyId, userId]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Historia no encontrada" }); return; }
    res.sendStatus(204);
});

export default router;
