import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import crypto from "crypto";

const router: IRouter = Router();

const KEY = Buffer.from(process.env.MESSAGE_ENCRYPTION_KEY ?? "", "hex");

function encrypt(text: string) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", KEY, iv);
  const enc = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return { encrypted: enc.toString("hex"), iv: iv.toString("hex") };
}

function decrypt(encryptedHex: string, ivHex: string): string {
  try {
    const iv = Buffer.from(ivHex, "hex");
    const enc = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", KEY, iv);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
  } catch {
    return "[mensaje cifrado]";
  }
}

async function rawQuery(text: string, values?: any[]) {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try { return await client.query(text, values); } finally { client.release(); }
}

// GET /dm-groups — list my DM groups
router.get("/dm-groups", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const result = await rawQuery(`
      SELECT dg.id, dg.name, dg.owner_id, dg.created_at,
             (SELECT COUNT(*) FROM dm_group_members WHERE group_id=dg.id) AS member_count
      FROM dm_groups dg
      JOIN dm_group_members dgm ON dgm.group_id=dg.id
      WHERE dgm.user_id=$1
      ORDER BY dg.created_at DESC
    `, [userId]);
    res.json(result.rows.map(r => ({
      id: r.id, name: r.name, ownerId: r.owner_id, createdAt: r.created_at, memberCount: Number(r.member_count)
    })));
});

// POST /dm-groups — create group
router.post("/dm-groups", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const { name, memberIds } = req.body;
    if (!name?.trim()) { res.status(400).json({ error: "Nombre requerido" }); return; }
    const ids: number[] = Array.isArray(memberIds) ? memberIds : [];

    const groupRes = await rawQuery(`INSERT INTO dm_groups (name, owner_id) VALUES ($1, $2) RETURNING *`, [name.trim(), userId]);
    const groupId = groupRes.rows[0].id;

    // Add creator + all members
    const allMembers = [...new Set([userId, ...ids])];
    for (const mid of allMembers) {
      await rawQuery(`INSERT INTO dm_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [groupId, mid]);
    }

    res.status(201).json({ id: groupId, name: name.trim(), ownerId: userId, memberCount: allMembers.length });
});

// GET /dm-groups/:groupId/members
router.get("/dm-groups/:groupId/members", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const groupId = parseInt(req.params.groupId as string, 10);
    // verify membership
    const check = await rawQuery(`SELECT 1 FROM dm_group_members WHERE group_id=$1 AND user_id=$2`, [groupId, userId]);
    if (!check.rows.length) { res.status(403).json({ error: "Sin acceso" }); return; }
    const result = await rawQuery(`
      SELECT u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status, u.status_emoji
      FROM dm_group_members dgm
      JOIN users u ON u.id=dgm.user_id
      WHERE dgm.group_id=$1
    `, [groupId]);
    res.json(result.rows.map(r => ({
      id: r.id, username: r.username, displayName: r.display_name,
      avatarUrl: r.avatar_url, status: r.status, customStatus: r.custom_status, statusEmoji: r.status_emoji
    })));
});

// POST /dm-groups/:groupId/members — add member
router.post("/dm-groups/:groupId/members", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const groupId = parseInt(req.params.groupId as string, 10);
    const { userId: newUserId } = req.body;
    // only owner can add
    const groupRes = await rawQuery(`SELECT * FROM dm_groups WHERE id=$1`, [groupId]);
    if (!groupRes.rows[0] || groupRes.rows[0].owner_id !== userId) {
      res.status(403).json({ error: "Solo el creador puede añadir miembros" }); return;
    }
    await rawQuery(`INSERT INTO dm_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [groupId, newUserId]);
    res.sendStatus(204);
});

// DELETE /dm-groups/:groupId/members/:memberId — remove member (owner or self-leave)
router.delete("/dm-groups/:groupId/members/:memberId", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const groupId = parseInt(req.params.groupId as string, 10);
    const memberId = parseInt(req.params.memberId as string, 10);
    if (memberId !== userId) {
      const groupRes = await rawQuery(`SELECT owner_id FROM dm_groups WHERE id=$1`, [groupId]);
      if (!groupRes.rows[0] || groupRes.rows[0].owner_id !== userId) {
        res.status(403).json({ error: "Sin permiso" }); return;
      }
    }
    await rawQuery(`DELETE FROM dm_group_members WHERE group_id=$1 AND user_id=$2`, [groupId, memberId]);
    res.sendStatus(204);
});

// GET /dm-groups/:groupId/messages
router.get("/dm-groups/:groupId/messages", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const groupId = parseInt(req.params.groupId as string, 10);
    const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined;
    const check = await rawQuery(`SELECT 1 FROM dm_group_members WHERE group_id=$1 AND user_id=$2`, [groupId, userId]);
    if (!check.rows.length) { res.status(403).json({ error: "Sin acceso" }); return; }

    let q = `
      SELECT m.id, m.group_id, m.user_id, m.content, m.iv, m.created_at, m.deleted_at,
             u.username, u.display_name, u.avatar_url
      FROM dm_group_messages m
      JOIN users u ON u.id=m.user_id
      WHERE m.group_id=$1 AND m.deleted_at IS NULL
    `;
    const params: any[] = [groupId];
    if (before) { q += ` AND m.id < $${params.length + 1}`; params.push(before); }
    q += ` ORDER BY m.created_at DESC LIMIT 50`;

    const result = await rawQuery(q, params);
    const messages = result.rows.reverse().map(r => ({
      id: r.id, groupId: r.group_id, userId: r.user_id,
      content: decrypt(r.content, r.iv),
      createdAt: r.created_at,
      author: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
    }));
    res.json(messages);
});

// POST /dm-groups/:groupId/messages
router.post("/dm-groups/:groupId/messages", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const groupId = parseInt(req.params.groupId as string, 10);
    const { content } = req.body;
    if (!content?.trim()) { res.status(400).json({ error: "Contenido requerido" }); return; }

    const check = await rawQuery(`SELECT 1 FROM dm_group_members WHERE group_id=$1 AND user_id=$2`, [groupId, userId]);
    if (!check.rows.length) { res.status(403).json({ error: "Sin acceso" }); return; }

    const { encrypted, iv } = encrypt(content.trim());
    const result = await rawQuery(
      `INSERT INTO dm_group_messages (group_id, user_id, content, iv) VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [groupId, userId, encrypted, iv]
    );
    const userRes = await rawQuery(`SELECT username, display_name, avatar_url FROM users WHERE id=$1`, [userId]);
    const u = userRes.rows[0];
    const msg = {
      id: result.rows[0].id, groupId, userId,
      content: content.trim(), createdAt: result.rows[0].created_at,
      author: { username: u.username, displayName: u.display_name, avatarUrl: u.avatar_url },
    };

    // Broadcast via WS
    const { broadcast } = await import("../lib/websocket");
    broadcast(`dm_group:${groupId}`, { type: "dm_group:message", data: msg });

    res.status(201).json(msg);
});

export default router;
