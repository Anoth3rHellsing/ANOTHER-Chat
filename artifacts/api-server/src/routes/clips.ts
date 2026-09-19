import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".mp4";
    cb(null, `clip-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB

function getBaseUrl() {
  return process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : "";
}

async function rawQuery(text: string, values?: any[]) {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try {
    return await client.query(text, values);
  } finally {
    client.release();
  }
}

// GET /servers/:serverId/clips
router.get("/servers/:serverId/clips", requireAuth, async (req, res): Promise<void> => {
    const serverId = parseInt(req.params.serverId as string, 10);
    const userId = req.session.userId!;

    const result = await rawQuery(`
      SELECT c.id, c.server_id, c.user_id, c.title, c.video_url, c.thumbnail_url, c.created_at,
             u.username, u.display_name, u.avatar_url,
             (SELECT COUNT(*) FROM clip_likes cl WHERE cl.clip_id = c.id) AS like_count,
             EXISTS(SELECT 1 FROM clip_likes cl WHERE cl.clip_id = c.id AND cl.user_id = $2) AS liked,
             (SELECT COUNT(*) FROM clip_comments cc WHERE cc.clip_id = c.id) AS comment_count
      FROM clips c
      JOIN users u ON u.id = c.user_id
      WHERE c.server_id = $1
      ORDER BY c.created_at DESC
    `, [serverId, userId]);

    res.json(result.rows.map(r => ({
      id: r.id,
      serverId: r.server_id,
      userId: r.user_id,
      title: r.title,
      videoUrl: r.video_url,
      thumbnailUrl: r.thumbnail_url,
      createdAt: r.created_at,
      author: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
      likeCount: Number(r.like_count),
      liked: r.liked,
      commentCount: Number(r.comment_count),
    })));
});

// POST /servers/:serverId/clips
router.post("/servers/:serverId/clips", requireAuth, upload.single("file"), async (req, res): Promise<void> => {
    const serverId = parseInt(req.params.serverId as string, 10);
    const userId = req.session.userId!;
    const { title } = req.body;
    if (!req.file || !title) { res.status(400).json({ error: "Se requiere archivo y título" }); return; }

    const baseUrl = getBaseUrl();
    const videoUrl = `${baseUrl}/api/uploads/${req.file.filename}`;

    const result = await rawQuery(
      `INSERT INTO clips (server_id, user_id, title, video_url) VALUES ($1, $2, $3, $4) RETURNING *`,
      [serverId, userId, title.trim(), videoUrl]
    );
    res.status(201).json(result.rows[0]);
});

// POST /clips/:clipId/like — toggle like
router.post("/clips/:clipId/like", requireAuth, async (req, res): Promise<void> => {
    const clipId = parseInt(req.params.clipId as string, 10);
    const userId = req.session.userId!;

    const existing = await rawQuery(
      `SELECT 1 FROM clip_likes WHERE clip_id = $1 AND user_id = $2`,
      [clipId, userId]
    );
    if (existing.rows.length > 0) {
      await rawQuery(`DELETE FROM clip_likes WHERE clip_id = $1 AND user_id = $2`, [clipId, userId]);
      res.json({ liked: false });
    } else {
      await rawQuery(`INSERT INTO clip_likes (clip_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [clipId, userId]);
      res.json({ liked: true });
    }
});

// GET /clips/:clipId/comments
router.get("/clips/:clipId/comments", requireAuth, async (req, res): Promise<void> => {
    const clipId = parseInt(req.params.clipId as string, 10);
    const result = await rawQuery(`
      SELECT cc.id, cc.content, cc.created_at, cc.user_id,
             u.username, u.display_name, u.avatar_url
      FROM clip_comments cc
      JOIN users u ON u.id = cc.user_id
      WHERE cc.clip_id = $1
      ORDER BY cc.created_at ASC
    `, [clipId]);

    res.json(result.rows.map(r => ({
      id: r.id,
      content: r.content,
      createdAt: r.created_at,
      userId: r.user_id,
      author: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
    })));
});

// POST /clips/:clipId/comments
router.post("/clips/:clipId/comments", requireAuth, async (req, res): Promise<void> => {
    const clipId = parseInt(req.params.clipId as string, 10);
    const userId = req.session.userId!;
    const { content } = req.body;
    if (!content?.trim()) { res.status(400).json({ error: "Contenido requerido" }); return; }

    const result = await rawQuery(
      `INSERT INTO clip_comments (clip_id, user_id, content) VALUES ($1, $2, $3) RETURNING *`,
      [clipId, userId, content.trim()]
    );

    const userRes = await rawQuery(`SELECT username, display_name, avatar_url FROM users WHERE id = $1`, [userId]);
    const u = userRes.rows[0];
    res.status(201).json({
      ...result.rows[0],
      createdAt: result.rows[0].created_at,
      userId: result.rows[0].user_id,
      author: { username: u.username, displayName: u.display_name, avatarUrl: u.avatar_url },
    });
});

// DELETE /clips/:clipId
router.delete("/clips/:clipId", requireAuth, async (req, res): Promise<void> => {
    const clipId = parseInt(req.params.clipId as string, 10);
    const userId = req.session.userId!;
    const result = await rawQuery(
      `DELETE FROM clips WHERE id = $1 AND user_id = $2 RETURNING id`,
      [clipId, userId]
    );
    if (!result.rows[0]) { res.status(404).json({ error: "Clip no encontrado" }); return; }
    res.sendStatus(204);
});

export default router;
