import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import crypto from "crypto";

const router: IRouter = Router();

const KEY = Buffer.from(process.env.MESSAGE_ENCRYPTION_KEY ?? "", "hex");

function decryptMsg(encryptedHex: string, ivHex: string): string {
  try {
    const iv = Buffer.from(ivHex, "hex");
    const enc = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", KEY, iv);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

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

    // Check user has access to this channel's server
    const chanRes = await rawQuery(`SELECT server_id FROM channels WHERE id=$1`, [channelId]);
    if (!chanRes.rows[0]) { res.status(404).json({ error: "Canal no encontrado" }); return; }
    const serverId = chanRes.rows[0].server_id;

    const memberCheck = await rawQuery(`SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2`, [serverId, userId]);
    if (!memberCheck.rows.length) { res.status(403).json({ error: "Sin acceso" }); return; }

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

    const results = msgs.rows
      .map(r => ({ ...r, decrypted: decryptMsg(r.content_encrypted, r.iv) }))
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

    // Fetch last 3000 messages from all accessible channels
    const msgs = await rawQuery(`
      SELECT m.id, m.channel_id, m.user_id, m.content_encrypted, m.iv, m.created_at, m.edited_at,
             c.name AS channel_name,
             u.username, u.display_name, u.avatar_url
      FROM messages m
      JOIN channels c ON c.id = m.channel_id
      JOIN users u ON u.id = m.user_id
      WHERE c.server_id=$1 AND m.deleted_at IS NULL
      ORDER BY m.created_at DESC
      LIMIT 3000
    `, [serverId]);

    const results = msgs.rows
      .map(r => ({ ...r, decrypted: decryptMsg(r.content_encrypted, r.iv) }))
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

    const results = msgs.rows
      .map(r => ({ ...r, decrypted: decryptMsg(r.content_encrypted, r.iv) }))
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
