import { Router, type IRouter } from "express";
import { requireAuth } from "../lib/auth";
import { encryptMessage } from "../lib/crypto";
import { decryptGroupMessage } from "../lib/message-crypto";
import {
  groupReactions,
  isSingleEmoji,
  MAX_DISTINCT_REACTIONS_PER_MESSAGE,
} from "../lib/reactions";

const router: IRouter = Router();

async function rawQuery(text: string, values?: any[]) {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try { return await client.query(text, values); } finally { client.release(); }
}

async function rawTransaction<T>(work: (client: any) => Promise<T>): Promise<T> {
    const { pool } = await import("@workspace/db");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
    const reactionRows = result.rows.length
      ? await rawQuery(
        `SELECT message_id, emoji, user_id FROM dm_group_reactions WHERE message_id = ANY($1::int[])`,
        [result.rows.map((r: any) => Number(r.id))],
      )
      : { rows: [] };
    const reactionsByMessage = new Map<number, Array<{ emoji: string; userId: number }>>();
    for (const row of reactionRows.rows) {
      const messageId = Number(row.message_id);
      const rows = reactionsByMessage.get(messageId) ?? [];
      rows.push({ emoji: row.emoji, userId: Number(row.user_id) });
      reactionsByMessage.set(messageId, rows);
    }

    const messages = await Promise.all(result.rows.reverse().map(async r => {
      let content = "[mensaje cifrado]";
      try {
        content = await decryptGroupMessage({ id: r.id, content: r.content, iv: r.iv });
      } catch {
        // Preserve the existing encrypted-message fallback.
      }
      return {
        id: r.id, groupId: r.group_id, userId: r.user_id,
        content,
        createdAt: r.created_at,
        author: { username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url },
        reactions: groupReactions(reactionsByMessage.get(Number(r.id)) ?? []),
      };
    }));
    res.json(messages);
});

// POST /dm-groups/:groupId/messages/:messageId/reactions — toggle reaction
router.post("/dm-groups/:groupId/messages/:messageId/reactions", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const groupId = parseInt(req.params.groupId as string, 10);
    const messageId = parseInt(req.params.messageId as string, 10);
    const emoji = req.body?.emoji;
    if (!Number.isInteger(groupId) || groupId < 1 || !Number.isInteger(messageId) || messageId < 1) {
      res.status(400).json({ error: "ID inválido" }); return;
    }
    if (!isSingleEmoji(emoji)) { res.status(400).json({ error: "Emoji inválido" }); return; }

    const result = await rawTransaction(async client => {
      const member = await client.query(
        `SELECT 1 FROM dm_group_members WHERE group_id=$1 AND user_id=$2 FOR KEY SHARE`,
        [groupId, userId],
      );
      if (!member.rows.length) return { status: "forbidden" as const };

      const locked = await client.query(
        `SELECT id FROM dm_group_messages WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [messageId, groupId],
      );
      if (!locked.rows.length) return { status: "missing" as const };

      const existing = await client.query(
        `SELECT id FROM dm_group_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`,
        [messageId, userId, emoji],
      );
      if (existing.rows.length) {
        await client.query(`DELETE FROM dm_group_reactions WHERE id=$1`, [existing.rows[0].id]);
      } else {
        const distinct = await client.query(
          `SELECT DISTINCT emoji FROM dm_group_reactions WHERE message_id=$1`,
          [messageId],
        );
        if (!distinct.rows.some((row: any) => row.emoji === emoji)
            && distinct.rows.length >= MAX_DISTINCT_REACTIONS_PER_MESSAGE) {
          return { status: "limit" as const };
        }
        await client.query(
          `INSERT INTO dm_group_reactions (message_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
          [messageId, userId, emoji],
        );
      }
      const rows = await client.query(
        `SELECT emoji, user_id FROM dm_group_reactions WHERE message_id=$1`,
        [messageId],
      );
      return {
        status: "ok" as const,
        reactions: groupReactions(rows.rows.map((row: any) => ({ emoji: row.emoji, userId: Number(row.user_id) }))),
      };
    });
    if (result.status === "forbidden") { res.status(403).json({ error: "Sin acceso" }); return; }
    if (result.status === "missing") { res.status(404).json({ error: "Mensaje no encontrado" }); return; }
    if (result.status === "limit") {
      res.status(400).json({ error: "El mensaje ya tiene el máximo de 20 emojis distintos" }); return;
    }

    const { broadcastToUser } = await import("../lib/websocket");
    const members = await rawQuery(`SELECT user_id FROM dm_group_members WHERE group_id=$1`, [groupId]);
    const payload = {
      type: "dm_group:reaction_update",
      data: { groupId, messageId, reactions: result.reactions },
    };
    for (const member of members.rows) broadcastToUser(Number(member.user_id), payload);
    res.json(result.reactions);
});

// DELETE /dm-groups/:groupId/messages/:messageId/reactions/:emoji
router.delete("/dm-groups/:groupId/messages/:messageId/reactions/:emoji", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const groupId = parseInt(req.params.groupId as string, 10);
    const messageId = parseInt(req.params.messageId as string, 10);
    const emoji = Array.isArray(req.params.emoji) ? req.params.emoji[0] : req.params.emoji;
    if (!Number.isInteger(groupId) || groupId < 1 || !Number.isInteger(messageId) || messageId < 1) {
      res.status(400).json({ error: "ID inválido" }); return;
    }
    if (!isSingleEmoji(emoji)) { res.status(400).json({ error: "Emoji inválido" }); return; }

    const result = await rawTransaction(async client => {
      const member = await client.query(
        `SELECT 1 FROM dm_group_members WHERE group_id=$1 AND user_id=$2 FOR KEY SHARE`,
        [groupId, userId],
      );
      if (!member.rows.length) return { status: "forbidden" as const };
      const locked = await client.query(
        `SELECT id FROM dm_group_messages WHERE id=$1 AND group_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [messageId, groupId],
      );
      if (!locked.rows.length) return { status: "missing" as const };
      await client.query(
        `DELETE FROM dm_group_reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`,
        [messageId, userId, emoji],
      );
      const rows = await client.query(
        `SELECT emoji, user_id FROM dm_group_reactions WHERE message_id=$1`,
        [messageId],
      );
      return {
        status: "ok" as const,
        reactions: groupReactions(rows.rows.map((row: any) => ({ emoji: row.emoji, userId: Number(row.user_id) }))),
      };
    });
    if (result.status === "forbidden") { res.status(403).json({ error: "Sin acceso" }); return; }
    if (result.status === "missing") { res.status(404).json({ error: "Mensaje no encontrado" }); return; }

    const { broadcastToUser } = await import("../lib/websocket");
    const members = await rawQuery(`SELECT user_id FROM dm_group_members WHERE group_id=$1`, [groupId]);
    const payload = {
      type: "dm_group:reaction_update",
      data: { groupId, messageId, reactions: result.reactions },
    };
    for (const member of members.rows) broadcastToUser(Number(member.user_id), payload);
    res.json(result.reactions);
});

// POST /dm-groups/:groupId/messages
router.post("/dm-groups/:groupId/messages", requireAuth, async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const groupId = parseInt(req.params.groupId as string, 10);
    const { content } = req.body;
    if (!content?.trim()) { res.status(400).json({ error: "Contenido requerido" }); return; }

    const check = await rawQuery(`SELECT 1 FROM dm_group_members WHERE group_id=$1 AND user_id=$2`, [groupId, userId]);
    if (!check.rows.length) { res.status(403).json({ error: "Sin acceso" }); return; }

    const { encrypted, iv } = encryptMessage(content.trim());
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
      reactions: [],
    };

    // Broadcast via WS
    const { broadcast } = await import("../lib/websocket");
    broadcast(`dm_group:${groupId}`, { type: "dm_group:message", data: msg });

    res.status(201).json(msg);
});

export default router;
