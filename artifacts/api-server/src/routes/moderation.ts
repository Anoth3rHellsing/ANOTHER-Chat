import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

async function rawQuery(text: string, values?: any[]) {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try { return await client.query(text, values); } finally { client.release(); }
}

async function addAuditLog(serverId: number, actorId: number | null, targetUserId: number | null, action: string, detail: object = {}) {
  try {
    await rawQuery(
      `INSERT INTO audit_log (server_id, actor_id, target_user_id, action, detail) VALUES ($1,$2,$3,$4,$5)`,
      [serverId, actorId, targetUserId, action, JSON.stringify(detail)]
    );
  } catch (err) {
    logger.error({ err }, "Failed to write audit log");
  }
}

// ─────────────── AUDIT LOG ───────────────

// GET /servers/:serverId/audit-log
router.get("/servers/:serverId/audit-log", requireAuth, async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const serverId = parseInt(req.params.serverId as string, 10);

    const memberRes = await rawQuery(`SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, userId]);
    if (!memberRes.rows[0] || !['admin','owner'].includes(memberRes.rows[0].role)) {
      res.status(403).json({ error: "Solo admins" }); return;
    }

    const result = await rawQuery(`
      SELECT al.id, al.action, al.detail, al.created_at,
             au.username AS actor_username, au.display_name AS actor_name, au.avatar_url AS actor_avatar,
             tu.username AS target_username, tu.display_name AS target_name
      FROM audit_log al
      LEFT JOIN users au ON au.id=al.actor_id
      LEFT JOIN users tu ON tu.id=al.target_user_id
      WHERE al.server_id=$1
      ORDER BY al.created_at DESC
      LIMIT 200
    `, [serverId]);

    res.json(result.rows.map(r => ({
      id: r.id, action: r.action, detail: r.detail, createdAt: r.created_at,
      actor: r.actor_username ? { username: r.actor_username, displayName: r.actor_name, avatarUrl: r.actor_avatar } : null,
      target: r.target_username ? { username: r.target_username, displayName: r.target_name } : null,
    })));
  } catch (err) {
    logger.error({ err }, "Error fetching audit log");
    res.status(500).json({ error: "Error interno" });
  }
});

// Export addAuditLog for use in other routes
export { addAuditLog };

// ─────────────── SERVER MUTES ────────────

// GET /servers/:serverId/mutes — list active mutes
router.get("/servers/:serverId/mutes", requireAuth, async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const serverId = parseInt(req.params.serverId as string, 10);
    const memberRes = await rawQuery(`SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, userId]);
    if (!memberRes.rows[0] || !['admin','owner','moderator'].includes(memberRes.rows[0].role)) {
      res.status(403).json({ error: "Sin permiso" }); return;
    }
    const result = await rawQuery(`
      SELECT sm.id, sm.user_id, sm.expires_at, sm.reason, sm.created_at,
             u.username, u.display_name, u.avatar_url,
             mu.username AS muted_by_username
      FROM server_mutes sm
      JOIN users u ON u.id=sm.user_id
      LEFT JOIN users mu ON mu.id=sm.muted_by_id
      WHERE sm.server_id=$1 AND sm.expires_at > NOW()
      ORDER BY sm.created_at DESC
    `, [serverId]);
    res.json(result.rows.map(r => ({
      id: r.id, userId: r.user_id, expiresAt: r.expires_at, reason: r.reason, createdAt: r.created_at,
      user: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
      mutedByUsername: r.muted_by_username,
    })));
  } catch (err) {
    logger.error({ err }, "Error listing mutes");
    res.status(500).json({ error: "Error interno" });
  }
});

// POST /servers/:serverId/mutes — mute a user
router.post("/servers/:serverId/mutes", requireAuth, async (req, res): Promise<void> => {
  try {
    const actorId = req.session.userId!;
    const serverId = parseInt(req.params.serverId as string, 10);
    const { userId: targetId, durationMinutes, reason } = req.body;

    const memberRes = await rawQuery(`SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, actorId]);
    if (!memberRes.rows[0] || !['admin','owner','moderator'].includes(memberRes.rows[0].role)) {
      res.status(403).json({ error: "Sin permiso" }); return;
    }

    const dur = Math.min(Math.max(parseInt(durationMinutes ?? 10, 10), 1), 43200); // 1 min to 30 days
    const expiresAt = new Date(Date.now() + dur * 60 * 1000);

    await rawQuery(`
      INSERT INTO server_mutes (server_id, user_id, muted_by_id, expires_at, reason)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (server_id, user_id) DO UPDATE SET expires_at=$4, reason=$5, muted_by_id=$3
    `, [serverId, targetId, actorId, expiresAt.toISOString(), reason ?? null]);

    await addAuditLog(serverId, actorId, targetId, 'member_muted', { durationMinutes: dur, reason });
    res.json({ expiresAt: expiresAt.toISOString() });
  } catch (err) {
    logger.error({ err }, "Error muting user");
    res.status(500).json({ error: "Error interno" });
  }
});

// DELETE /servers/:serverId/mutes/:muteId — unmute
router.delete("/servers/:serverId/mutes/:muteId", requireAuth, async (req, res): Promise<void> => {
  try {
    const actorId = req.session.userId!;
    const serverId = parseInt(req.params.serverId as string, 10);
    const muteId = parseInt(req.params.muteId as string, 10);
    const memberRes = await rawQuery(`SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, actorId]);
    if (!memberRes.rows[0] || !['admin','owner','moderator'].includes(memberRes.rows[0].role)) {
      res.status(403).json({ error: "Sin permiso" }); return;
    }
    const muteRes = await rawQuery(`DELETE FROM server_mutes WHERE id=$1 AND server_id=$2 RETURNING user_id`, [muteId, serverId]);
    if (muteRes.rows[0]) {
      await addAuditLog(serverId, actorId, muteRes.rows[0].user_id, 'member_unmuted', {});
    }
    res.sendStatus(204);
  } catch (err) {
    logger.error({ err }, "Error removing mute");
    res.status(500).json({ error: "Error interno" });
  }
});

// GET /servers/:serverId/mute-status — check if current user is muted
router.get("/servers/:serverId/mute-status", requireAuth, async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const serverId = parseInt(req.params.serverId as string, 10);
    const result = await rawQuery(
      `SELECT expires_at, reason FROM server_mutes WHERE server_id=$1 AND user_id=$2 AND expires_at > NOW()`,
      [serverId, userId]
    );
    if (result.rows[0]) {
      res.json({ muted: true, expiresAt: result.rows[0].expires_at, reason: result.rows[0].reason });
    } else {
      res.json({ muted: false });
    }
  } catch (err) {
    logger.error({ err }, "Error checking mute status");
    res.status(500).json({ error: "Error interno" });
  }
});

// ─────────────── MESSAGE REPORTS ─────────

// POST /messages/:messageId/report
router.post("/messages/:messageId/report", requireAuth, async (req, res): Promise<void> => {
  try {
    const reporterId = req.session.userId!;
    const messageId = parseInt(req.params.messageId as string, 10);
    const { reason, serverId } = req.body;
    if (!reason?.trim()) { res.status(400).json({ error: "Motivo requerido" }); return; }

    await rawQuery(`
      INSERT INTO message_reports (message_id, reporter_id, server_id, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING
    `, [messageId, reporterId, serverId ?? null, reason.trim()]);
    res.status(201).json({ reported: true });
  } catch (err) {
    logger.error({ err }, "Error reporting message");
    res.status(500).json({ error: "Error interno" });
  }
});

// GET /servers/:serverId/reports — admin: pending reports
router.get("/servers/:serverId/reports", requireAuth, async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const serverId = parseInt(req.params.serverId as string, 10);
    const memberRes = await rawQuery(`SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, userId]);
    if (!memberRes.rows[0] || !['admin','owner'].includes(memberRes.rows[0].role)) {
      res.status(403).json({ error: "Solo admins" }); return;
    }
    const result = await rawQuery(`
      SELECT mr.id, mr.message_id, mr.reason, mr.status, mr.created_at,
             ru.username AS reporter_username,
             mu.id AS msg_user_id, mu.username AS msg_username, mu.display_name AS msg_display_name
      FROM message_reports mr
      JOIN users ru ON ru.id=mr.reporter_id
      JOIN messages msg ON msg.id=mr.message_id
      JOIN users mu ON mu.id=msg.user_id
      WHERE mr.server_id=$1
      ORDER BY mr.created_at DESC
      LIMIT 100
    `, [serverId]);
    res.json(result.rows.map(r => ({
      id: r.id, messageId: r.message_id, reason: r.reason, status: r.status, createdAt: r.created_at,
      reporter: { username: r.reporter_username },
      messageAuthor: { id: r.msg_user_id, username: r.msg_username, displayName: r.msg_display_name },
    })));
  } catch (err) {
    logger.error({ err }, "Error fetching reports");
    res.status(500).json({ error: "Error interno" });
  }
});

// PATCH /reports/:reportId — resolve report
router.patch("/reports/:reportId", requireAuth, async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const reportId = parseInt(req.params.reportId as string, 10);
    const { action } = req.body; // 'dismiss' | 'delete_message'

    const reportRes = await rawQuery(`SELECT * FROM message_reports WHERE id=$1`, [reportId]);
    if (!reportRes.rows[0]) { res.status(404).json({ error: "No encontrado" }); return; }
    const report = reportRes.rows[0];
    if (!report.server_id) { res.status(400).json({ error: "No hay servidor asociado" }); return; }

    // Check admin
    const memberRes = await rawQuery(`SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2`, [report.server_id, userId]);
    if (!memberRes.rows[0] || !['admin','owner'].includes(memberRes.rows[0].role)) {
      res.status(403).json({ error: "Solo admins" }); return;
    }

    await rawQuery(`UPDATE message_reports SET status=$1, resolved_by_id=$2, resolved_at=NOW() WHERE id=$3`, [action === 'dismiss' ? 'dismissed' : 'resolved', userId, reportId]);

    if (action === 'delete_message') {
      await rawQuery(`UPDATE messages SET deleted_at=NOW() WHERE id=$1`, [report.message_id]);
      await addAuditLog(report.server_id, userId, null, 'message_deleted_via_report', { messageId: report.message_id });
    }

    res.json({ resolved: true });
  } catch (err) {
    logger.error({ err }, "Error resolving report");
    res.status(500).json({ error: "Error interno" });
  }
});

// ─────────────── WORD FILTERS ────────────

// GET /servers/:serverId/word-filters
router.get("/servers/:serverId/word-filters", requireAuth, async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const serverId = parseInt(req.params.serverId as string, 10);
    const memberRes = await rawQuery(`SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, userId]);
    if (!memberRes.rows[0] || !['admin','owner'].includes(memberRes.rows[0].role)) {
      res.status(403).json({ error: "Solo admins" }); return;
    }
    const result = await rawQuery(`SELECT id, word, created_at FROM word_filters WHERE server_id=$1 ORDER BY word`, [serverId]);
    res.json(result.rows);
  } catch (err) {
    logger.error({ err }, "Error fetching word filters");
    res.status(500).json({ error: "Error interno" });
  }
});

// POST /servers/:serverId/word-filters
router.post("/servers/:serverId/word-filters", requireAuth, async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const serverId = parseInt(req.params.serverId as string, 10);
    const { word } = req.body;
    if (!word?.trim()) { res.status(400).json({ error: "Palabra requerida" }); return; }
    const memberRes = await rawQuery(`SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, userId]);
    if (!memberRes.rows[0] || !['admin','owner'].includes(memberRes.rows[0].role)) {
      res.status(403).json({ error: "Solo admins" }); return;
    }
    const result = await rawQuery(
      `INSERT INTO word_filters (server_id, word, created_by_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *`,
      [serverId, word.trim().toLowerCase(), userId]
    );
    res.status(201).json(result.rows[0] ?? { duplicate: true });
  } catch (err) {
    logger.error({ err }, "Error adding word filter");
    res.status(500).json({ error: "Error interno" });
  }
});

// DELETE /servers/:serverId/word-filters/:filterId
router.delete("/servers/:serverId/word-filters/:filterId", requireAuth, async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const serverId = parseInt(req.params.serverId as string, 10);
    const filterId = parseInt(req.params.filterId as string, 10);
    const memberRes = await rawQuery(`SELECT role FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, userId]);
    if (!memberRes.rows[0] || !['admin','owner'].includes(memberRes.rows[0].role)) {
      res.status(403).json({ error: "Solo admins" }); return;
    }
    await rawQuery(`DELETE FROM word_filters WHERE id=$1 AND server_id=$2`, [filterId, serverId]);
    res.sendStatus(204);
  } catch (err) {
    logger.error({ err }, "Error removing word filter");
    res.status(500).json({ error: "Error interno" });
  }
});

// GET /servers/:serverId/word-filters/check — internal: get list for frontend censoring
router.get("/servers/:serverId/word-filters/list", requireAuth, async (req, res): Promise<void> => {
  try {
    const userId = req.session.userId!;
    const serverId = parseInt(req.params.serverId as string, 10);
    const memberRes = await rawQuery(`SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, userId]);
    if (!memberRes.rows.length) { res.status(403).json({ error: "Sin acceso" }); return; }
    const result = await rawQuery(`SELECT word FROM word_filters WHERE server_id=$1`, [serverId]);
    res.json(result.rows.map(r => r.word));
  } catch (err) {
    logger.error({ err }, "Error fetching word list");
    res.status(500).json({ error: "Error interno" });
  }
});

export default router;
