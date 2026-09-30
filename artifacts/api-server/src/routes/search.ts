import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { decryptChannelMessage, decryptDirectMessage } from "../lib/message-crypto";
import { canAccessChannel } from "../lib/permissions";

const router: IRouter = Router();

async function rawQuery(text: string, values?: any[]) {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try { return await client.query(text, values); } finally { client.release(); }
}

// GET /channels/:channelId/search?q=term — search messages in a channel
router.get("/channels/:channelId/search", requireAuth, async (req, res): Promise<void> => {
    const channelId = parseInt(req.params.channelId as string, 10);
    const userId = req.session.userId!;
    const q = (req.query.q as string ?? "").trim().toLowerCase();
    if (!q || q.length < 2) { res.json([]); return; }

    // Mismo criterio que leer el canal: pertenencia y roles restringidos.
    const chanRes = await rawQuery(`SELECT server_id, restricted_roles FROM channels WHERE id=$1`, [channelId]);
    if (!chanRes.rows[0]) { res.status(404).json({ error: "Canal no encontrado" }); return; }
    const channel = { serverId: chanRes.rows[0].server_id, restrictedRoles: chanRes.rows[0].restricted_roles };
    if (!(await canAccessChannel(channel, userId, req.session.userRole))) {
      res.status(403).json({ error: "Sin acceso" });
      return;
    }

    // Fetch messages (limit to last 2000 for performance)
    const msgs = await rawQuery(`
      SELECT m.id, m.channel_id, m.user_id, m.content_encrypted, m.iv, m.created_at, m.edited_at,
             u.username, u.display_name, u.avatar_url
      FROM messages m
      JOIN users u ON u.id = m.user_id
      WHERE m.channel_id=$1 AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT 2000
    `, [channelId]);

    const decryptedRows = await Promise.all(msgs.rows.map(async r => {
      try {
        return {
          ...r,
          decrypted: await decryptChannelMessage({
            id: r.id,
            contentEncrypted: r.content_encrypted,
            iv: r.iv,
          }),
        };
      } catch {
        return { ...r, decrypted: "" };
      }
    }));
    const results = decryptedRows
      .filter(r => r.decrypted.toLowerCase().includes(q))
      .slice(0, 50)
      .map(r => ({
        id: r.id, channelId: r.channel_id, userId: r.user_id,
        content: r.decrypted, createdAt: r.created_at, editedAt: r.edited_at,
        author: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
      }));

    res.json(results);
});

// GET /servers/:serverId/search?q=term — global search across a server
router.get("/servers/:serverId/search", requireAuth, async (req, res): Promise<void> => {
    const serverId = parseInt(req.params.serverId as string, 10);
    const userId = req.session.userId!;
    const q = (req.query.q as string ?? "").trim().toLowerCase();
    if (!q || q.length < 2) { res.json([]); return; }

    const memberCheck = await rawQuery(`SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, userId]);
    if (!memberCheck.rows.length) { res.status(403).json({ error: "Sin acceso" }); return; }

    // Solo los canales que este usuario puede leer; se filtra antes de descifrar.
    const channelRows = await rawQuery(`SELECT id, server_id, restricted_roles FROM channels WHERE server_id=$1`, [serverId]);
    const accessibleChannelIds: number[] = [];
    for (const row of channelRows.rows) {
      const channel = { serverId: row.server_id, restrictedRoles: row.restricted_roles };
      if (await canAccessChannel(channel, userId, req.session.userRole)) accessibleChannelIds.push(row.id);
    }
    if (accessibleChannelIds.length === 0) { res.json([]); return; }

    // Últimos 3000 mensajes de esos canales
    const msgs = await rawQuery(`
      SELECT m.id, m.channel_id, m.user_id, m.content_encrypted, m.iv, m.created_at, m.edited_at,
             c.name AS channel_name,
             u.username, u.display_name, u.avatar_url
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
      JOIN users u ON u.id = m.user_id
      WHERE c.server_id=$1 AND c.id = ANY($2::int[]) AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT 3000
    `, [serverId, accessibleChannelIds]);

    const decryptedRows = await Promise.all(msgs.rows.map(async r => {
      try {
        return {
          ...r,
          decrypted: await decryptChannelMessage({
            id: r.id,
            contentEncrypted: r.content_encrypted,
            iv: r.iv,
          }),
        };
      } catch {
        return { ...r, decrypted: "" };
      }
    }));
    const results = decryptedRows
      .filter(r => r.decrypted.toLowerCase().includes(q))
      .slice(0, 50)
      .map(r => ({
        id: r.id, channelId: r.channel_id, channelName: r.channel_name, userId: r.user_id,
        content: r.decrypted, createdAt: r.created_at, editedAt: r.edited_at,
        author: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
      }));

    res.json(results);
});

// GET /dms/:userId/search?q=term — search DM history
router.get("/dms/:userId/search", requireAuth, async (req, res): Promise<void> => {
    const myId = req.session.userId!;
    const otherId = parseInt(req.params.userId as string, 10);
    const q = (req.query.q as string ?? "").trim().toLowerCase();
    if (!q || q.length < 2) { res.json([]); return; }

    const msgs = await rawQuery(`
      SELECT dm.id, dm.sender_id, dm.recipient_id, dm.content_encrypted, dm.iv, dm.created_at,
             u.username, u.display_name, u.avatar_url
      FROM direct_messages dm
      JOIN users u ON u.id = dm.sender_id
      WHERE ((dm.sender_id=$1 AND dm.recipient_id=$2) OR (dm.sender_id=$2 AND dm.recipient_id=$1))
        AND dm.deleted_at IS NULL
      ORDER BY dm.created_at DESC
      LIMIT 1000
    `, [myId, otherId]);

    const decryptedRows = await Promise.all(msgs.rows.map(async r => {
      try {
        return {
          ...r,
          decrypted: await decryptDirectMessage({
            id: r.id,
            contentEncrypted: r.content_encrypted,
            iv: r.iv,
          }),
        };
      } catch {
        return { ...r, decrypted: "" };
      }
    }));
    const results = decryptedRows
      .filter(r => r.decrypted.toLowerCase().includes(q))
      .slice(0, 30)
      .map(r => ({
        id: r.id, senderId: r.sender_id, recipientId: r.recipient_id,
        content: r.decrypted, createdAt: r.created_at,
        author: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
      }));

    res.json(results);
});

export default router;
