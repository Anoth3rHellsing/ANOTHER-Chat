import { Router, type IRouter } from "express";
import { eq, and, or, desc, gt, sql, inArray } from "drizzle-orm";
import { db, directMessagesTable, dmReadCursorsTable, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { encryptMessage } from "../lib/crypto";
import { decryptDirectMessage } from "../lib/message-crypto";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseId(raw: string | string[]): number {
  return parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
}

async function buildDmResponse(
  msg: typeof directMessagesTable.$inferSelect,
  sender: typeof usersTable.$inferSelect | undefined,
  replyMsg?: typeof directMessagesTable.$inferSelect | null,
  replySender?: typeof usersTable.$inferSelect | null,
) {
  let content = "[mensaje eliminado]";
  if (!msg.deletedAt) {
    try {
      content = await decryptDirectMessage(msg);
    } catch {
      content = "[error al descifrar]";
    }
  }

  let replyTo: { id: number; authorDisplayName: string; contentPreview: string } | null = null;
  if (replyMsg && replySender) {
    let rc = "";
    try {
      rc = await decryptDirectMessage(replyMsg);
    } catch {
      // Preserve the existing empty reply preview fallback.
    }
    replyTo = { id: replyMsg.id, authorDisplayName: replySender.displayName, contentPreview: rc.slice(0, 100) };
  }

  return {
    id: msg.id,
    senderId: msg.senderId,
    recipientId: msg.recipientId,
    content,
    replyToId: msg.replyToId ?? null,
    deletedAt: msg.deletedAt?.toISOString() ?? null,
    createdAt: msg.createdAt.toISOString(),
    sender: sender ? {
      id: sender.id,
      username: sender.username,
      displayName: sender.displayName,
      bio: sender.bio ?? null,
      avatarUrl: sender.avatarUrl ?? null,
      bannerUrl: sender.bannerUrl ?? null,
      status: sender.status,
      role: sender.role,
      createdAt: sender.createdAt.toISOString(),
      socialLinks: (sender as any).socialLinks ?? [],
    } : null,
    replyTo,
  };
}

// ─── GET /dms — conversation list ─────────────────────────────────────────────
router.get("/dms", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;

  // Find all unique partners by looking at sent and received messages
  const rows = await db
    .select()
    .from(directMessagesTable)
    .where(
      and(
        or(
          eq(directMessagesTable.senderId, userId),
          eq(directMessagesTable.recipientId, userId),
        ),
      )
    )
    .orderBy(desc(directMessagesTable.createdAt));

  // Build partner set (ordered by most recent message per partner)
  const partnerOrder: number[] = [];
  const partnerSeen = new Set<number>();
  const lastMessageByPartner = new Map<number, typeof directMessagesTable.$inferSelect>();

  for (const msg of rows) {
    const partner = msg.senderId === userId ? msg.recipientId : msg.senderId;
    if (!partnerSeen.has(partner)) {
      partnerOrder.push(partner);
      partnerSeen.add(partner);
      lastMessageByPartner.set(partner, msg);
    }
  }

  if (partnerOrder.length === 0) {
    res.json([]);
    return;
  }

  // Fetch partner user profiles AND current user (current user may be lastMessage sender)
  const allRelevantIds = [...new Set([...partnerOrder, userId])];
  const partnerUsers = await db
    .select()
    .from(usersTable)
    .where(inArray(usersTable.id, allRelevantIds));
  const userMap = new Map(partnerUsers.map(u => [u.id, u]));

  // Fetch read cursors
  const cursors = await db
    .select()
    .from(dmReadCursorsTable)
    .where(and(eq(dmReadCursorsTable.userId, userId)));
  const cursorMap = new Map(cursors.map(c => [c.otherUserId, c.lastReadAt]));

  // Count unreads per partner
  const conversations = await Promise.all(
    partnerOrder.map(async (partnerId) => {
      const lastRead = cursorMap.get(partnerId);
      const unreadCount = lastRead
        ? rows.filter(m => m.recipientId === userId && m.senderId === partnerId && !m.deletedAt && m.createdAt > lastRead).length
        : rows.filter(m => m.recipientId === userId && m.senderId === partnerId && !m.deletedAt).length;

      const lastMsg = lastMessageByPartner.get(partnerId)!;
      const sender = userMap.get(lastMsg.senderId);
      const lastMessageObj = await buildDmResponse(lastMsg, sender);

      return {
        otherUser: (() => {
          const u = userMap.get(partnerId);
          if (!u) return null;
          return {
            id: u.id, username: u.username, displayName: u.displayName,
            bio: u.bio ?? null, avatarUrl: u.avatarUrl ?? null, bannerUrl: u.bannerUrl ?? null,
            status: u.status, role: u.role, createdAt: u.createdAt.toISOString(),
            socialLinks: (u as any).socialLinks ?? [],
          };
        })(),
        lastMessage: lastMessageObj,
        unreadCount,
      };
    })
  );

  res.json(conversations.filter(c => c.otherUser !== null));
});

// ─── GET /dms/:userId — history ───────────────────────────────────────────────
router.get("/dms/:userId", requireAuth, async (req, res): Promise<void> => {
  const myId = req.session.userId!;
  const otherId = parseId(req.params.userId);

  if (isNaN(otherId) || otherId === myId) {
    res.status(400).json({ error: "ID de usuario inválido" }); return;
  }

  // Check other user exists
  const [other] = await db.select().from(usersTable).where(eq(usersTable.id, otherId));
  if (!other) { res.status(404).json({ error: "Usuario no encontrado" }); return; }

  const msgs = await db
    .select()
    .from(directMessagesTable)
    .where(
      or(
        and(eq(directMessagesTable.senderId, myId), eq(directMessagesTable.recipientId, otherId)),
        and(eq(directMessagesTable.senderId, otherId), eq(directMessagesTable.recipientId, myId)),
      )
    )
    .orderBy(desc(directMessagesTable.createdAt))
    .limit(50);

  // Reverse so oldest first
  msgs.reverse();

  // Batch-fetch senders (only 2 possible: myId and otherId)
  const senderIds = [...new Set(msgs.map(m => m.senderId))];
  const senders = await db.select().from(usersTable).where(inArray(usersTable.id, senderIds));
  const senderMap = new Map(senders.map(u => [u.id, u]));

  // Batch reply messages
  const replyIds = msgs.map(m => m.replyToId).filter(Boolean) as number[];
  const replyMsgs = replyIds.length
    ? await db.select().from(directMessagesTable).where(inArray(directMessagesTable.id, replyIds))
    : [];
  const replyMap = new Map(replyMsgs.map(m => [m.id, m]));
  const replySenderIds = [...new Set(replyMsgs.map(m => m.senderId))];
  const replySenders = replySenderIds.length
    ? await db.select().from(usersTable).where(inArray(usersTable.id, replySenderIds))
    : [];
  const replySenderMap = new Map(replySenders.map(u => [u.id, u]));

  const result = await Promise.all(
    msgs.map(msg => {
      const replyMsg = msg.replyToId ? replyMap.get(msg.replyToId) : null;
      const replySender = replyMsg ? replySenderMap.get(replyMsg.senderId) : null;
      return buildDmResponse(msg, senderMap.get(msg.senderId), replyMsg, replySender);
    })
  );

  res.json(result);
});

// ─── POST /dms/:userId — send DM ─────────────────────────────────────────────
router.post("/dms/:userId", requireAuth, async (req, res): Promise<void> => {
  const senderId = req.session.userId!;
  const recipientId = parseId(req.params.userId);

  if (isNaN(recipientId) || recipientId === senderId) {
    res.status(400).json({ error: "ID de destinatario inválido" }); return;
  }

  const [recipient] = await db.select().from(usersTable).where(eq(usersTable.id, recipientId));
  if (!recipient) { res.status(404).json({ error: "Usuario no encontrado" }); return; }

  const { content, replyToId } = req.body;
  if (!content || typeof content !== "string" || content.trim().length === 0) {
    res.status(400).json({ error: "El contenido no puede estar vacío" }); return;
  }
  if (content.trim().length > 4000) {
    res.status(400).json({ error: "Mensaje demasiado largo" }); return;
  }

  // Validate replyToId if provided
  let validReplyToId: number | null = null;
  if (replyToId != null) {
    const replyIdNum = Number(replyToId);
    if (!isNaN(replyIdNum)) {
      const [replyMsg] = await db.select().from(directMessagesTable)
        .where(
          and(
            eq(directMessagesTable.id, replyIdNum),
            or(
              and(eq(directMessagesTable.senderId, senderId), eq(directMessagesTable.recipientId, recipientId)),
              and(eq(directMessagesTable.senderId, recipientId), eq(directMessagesTable.recipientId, senderId)),
            )
          )
        );
      if (replyMsg) validReplyToId = replyMsg.id;
    }
  }

  const { encrypted, iv } = encryptMessage(content.trim());
  const [msg] = await db.insert(directMessagesTable).values({
    senderId,
    recipientId,
    contentEncrypted: encrypted,
    iv,
    replyToId: validReplyToId,
  }).returning();

  const [sender] = await db.select().from(usersTable).where(eq(usersTable.id, senderId));

  let replyPreview = null;
  if (validReplyToId) {
    const [replyMsg] = await db.select().from(directMessagesTable).where(eq(directMessagesTable.id, validReplyToId));
    if (replyMsg) {
      const [rSender] = await db.select().from(usersTable).where(eq(usersTable.id, replyMsg.senderId));
      replyPreview = replyMsg;
      const response = await buildDmResponse(msg, sender, replyMsg, rSender);
      const payload = { type: "dm_message", data: response };
      const { broadcastToUser } = await import("../lib/websocket");
      broadcastToUser(recipientId, payload);
      broadcastToUser(senderId, payload);
      res.status(201).json(response);
      return;
    }
  }

  const response = await buildDmResponse(msg, sender);
  const payload = { type: "dm_message", data: response };
  const { broadcastToUser } = await import("../lib/websocket");
  broadcastToUser(recipientId, payload);
  broadcastToUser(senderId, payload);

  res.status(201).json(response);
});

// ─── POST /dms/:userId/read — mark read ───────────────────────────────────────
router.post("/dms/:userId/read", requireAuth, async (req, res): Promise<void> => {
  const myId = req.session.userId!;
  const otherId = parseId(req.params.userId);

  if (isNaN(otherId)) { res.status(400).json({ error: "ID inválido" }); return; }

  await db
    .insert(dmReadCursorsTable)
    .values({ userId: myId, otherUserId: otherId, lastReadAt: new Date() })
    .onConflictDoUpdate({
      target: [dmReadCursorsTable.userId, dmReadCursorsTable.otherUserId],
      set: { lastReadAt: new Date() },
    });

  res.status(204).end();
});

// ─── DELETE /dms/messages/:dmId — soft-delete ────────────────────────────────
router.delete("/dms/messages/:dmId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const dmId = parseId(req.params.dmId);

  if (isNaN(dmId)) { res.status(400).json({ error: "ID inválido" }); return; }

  const [msg] = await db.select().from(directMessagesTable).where(eq(directMessagesTable.id, dmId));
  if (!msg) { res.status(404).json({ error: "Mensaje no encontrado" }); return; }
  if (msg.senderId !== userId) { res.status(403).json({ error: "Solo puedes eliminar tus propios mensajes" }); return; }

  const [updated] = await db
    .update(directMessagesTable)
    .set({ deletedAt: new Date() })
    .where(eq(directMessagesTable.id, dmId))
    .returning();

  const [sender] = await db.select().from(usersTable).where(eq(usersTable.id, updated.senderId));
  const response = await buildDmResponse(updated, sender);

  const payload = { type: "dm_message_delete", data: response };
  const { broadcastToUser } = await import("../lib/websocket");
  broadcastToUser(updated.recipientId, payload);
  broadcastToUser(updated.senderId, payload);

  res.json(response);
});

export default router;
