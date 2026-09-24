import { Router, type IRouter, type Request } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { eq, and, gt, sql } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

const MAX_ACTIVE_STORIES = 10;
const STORY_LOCK_NAMESPACE = 72841;
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
