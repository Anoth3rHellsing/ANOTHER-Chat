import { Router, type IRouter } from "express";
import { eq, and, lt, desc, inArray, isNull } from "drizzle-orm";
import {
  db,
  channelsTable,
  messagesTable,
  messageAttachmentsTable,
  messageReactionsTable,
  serverMembersTable,
  serversTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { encryptMessage } from "../lib/crypto";
import { decryptChannelMessage } from "../lib/message-crypto";
import {
  getMemberPermissions,
  canAccessChannel,
  parseRestrictedRoles,
  PERM,
  hasPerm,
} from "../lib/permissions";
import { fetchFirstLinkPreview } from "../lib/link-preview";
import { groupReactions } from "../lib/reactions";

const router: IRouter = Router();

class AttachmentClaimError extends Error {}

function parseVisualConfig(raw: string | null | undefined): Record<string, any> {
  try { return JSON.parse(raw ?? "{}") as Record<string, any>; } catch { return {}; }
}

function serializeChannel(c: typeof channelsTable.$inferSelect) {
  return {
    id: c.id,
    serverId: c.serverId,
    name: c.name,
    channelType: c.channelType ?? "text",
    restrictedRoles: parseRestrictedRoles(c.restrictedRoles),
    visualConfig: parseVisualConfig(c.visualConfig),
    createdAt: c.createdAt,
  };
}

function serializeAuthor(author: typeof usersTable.$inferSelect | undefined) {
  if (!author) return null;
  return {
    id: author.id,
    username: author.username,
    displayName: author.displayName,
    bio: author.bio,
    avatarUrl: author.avatarUrl,
    bannerUrl: author.bannerUrl,
    status: author.status,
    role: author.role,
    createdAt: author.createdAt,
  };
}

async function buildMessageResponse(
  msg: typeof messagesTable.$inferSelect,
  decryptedContent: string,
  authorRow: typeof usersTable.$inferSelect | undefined,
  attachmentRows: Array<typeof messageAttachmentsTable.$inferSelect>,
  reactionRows: Array<{ emoji: string; userId: number }>,
  replyToData: { id: number; authorDisplayName: string; contentPreview: string } | null,
  linkPreviewData: Awaited<ReturnType<typeof fetchFirstLinkPreview>>,
) {
  return {
    id: msg.id,
    channelId: msg.channelId,
    userId: msg.userId,
    content: decryptedContent,
    replyToId: msg.replyToId ?? null,
    editedAt: msg.editedAt,
    deletedAt: msg.deletedAt,
    createdAt: msg.createdAt,
    author: serializeAuthor(authorRow),
    attachments: attachmentRows.map(a => ({
      id: a.id,
      url: a.url,
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
    reactions: groupReactions(reactionRows),
    replyTo: replyToData ?? null,
    linkPreview: linkPreviewData ?? null,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /servers/:serverId/channels
router.get("/servers/:serverId/channels", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const serverId = parseInt(Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId, 10);

  const channels = await db
    .select()
    .from(channelsTable)
    .where(eq(channelsTable.serverId, serverId));

  const accessible: typeof channels = [];
  for (const c of channels) {
    if (await canAccessChannel(c, userId, req.session.userRole)) {
      accessible.push(c);
    }
  }

  res.json(accessible.map(serializeChannel));
});

// POST /servers/:serverId/channels
router.post("/servers/:serverId/channels", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const serverId = parseInt(Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId, 10);
  const { name, restrictedRoles, channelType, visualConfig } = req.body;

  if (!name) {
    res.status(400).json({ error: "El nombre del canal es requerido" }); return;
  }

  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) { res.status(404).json({ error: "Servidor no encontrado" }); return; }

  const perms = await getMemberPermissions(serverId, userId);
  const isAllowed =
    req.session.userRole === "admin" ||
    perms === 0xffffffff ||
    hasPerm(perms, PERM.MANAGE_CHANNELS);

  if (!isAllowed) {
    res.status(403).json({ error: "No tienes permiso para crear canales" }); return;
  }

  const restrictedRolesJson = JSON.stringify(
    Array.isArray(restrictedRoles) ? restrictedRoles.map(Number) : []
  );
  const validType = ["text", "voice", "media"].includes(channelType) ? channelType : "text";
  const visualConfigJson = visualConfig ? JSON.stringify(visualConfig) : "{}";

  const [channel] = await db
    .insert(channelsTable)
    .values({ serverId, name, restrictedRoles: restrictedRolesJson, channelType: validType, visualConfig: visualConfigJson })
    .returning();

  res.status(201).json(serializeChannel(channel));
});

// PATCH /channels/:channelId
router.patch("/channels/:channelId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const channelId = parseInt(Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId, 10);

  const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
  if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }

  const perms = await getMemberPermissions(channel.serverId, userId);
  const isAllowed =
    req.session.userRole === "admin" ||
    perms === 0xffffffff ||
    hasPerm(perms, PERM.MANAGE_CHANNELS);

  if (!isAllowed) {
    res.status(403).json({ error: "No tienes permiso para editar canales" }); return;
  }

  const updates: Record<string, any> = {};
  if (req.body.name) updates.name = req.body.name;
  if (req.body.channelType && ["text", "voice", "media"].includes(req.body.channelType)) {
    updates.channelType = req.body.channelType;
  }
  if (req.body.restrictedRoles !== undefined) {
    updates.restrictedRoles = JSON.stringify(
      Array.isArray(req.body.restrictedRoles) ? req.body.restrictedRoles.map(Number) : []
    );
  }
  if (req.body.visualConfig !== undefined) {
    updates.visualConfig = JSON.stringify(req.body.visualConfig ?? {});
  }

  const [updated] = await db
    .update(channelsTable)
    .set(updates)
    .where(eq(channelsTable.id, channelId))
    .returning();

  res.json(serializeChannel(updated));
});

// DELETE /channels/:channelId
router.delete("/channels/:channelId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const channelId = parseInt(Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId, 10);

  const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
  if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }

  const perms = await getMemberPermissions(channel.serverId, userId);
  const isAllowed =
    req.session.userRole === "admin" ||
    perms === 0xffffffff ||
    hasPerm(perms, PERM.MANAGE_CHANNELS);

  if (!isAllowed) {
    res.status(403).json({ error: "No tienes permiso para eliminar canales" }); return;
  }

  await db.delete(messageAttachmentsTable).where(
    inArray(messageAttachmentsTable.messageId,
      db.select({ id: messagesTable.id }).from(messagesTable).where(eq(messagesTable.channelId, channelId))
    )
  );
  await db.delete(messageReactionsTable).where(
    inArray(messageReactionsTable.messageId,
      db.select({ id: messagesTable.id }).from(messagesTable).where(eq(messagesTable.channelId, channelId))
    )
  );
  await db.delete(messagesTable).where(eq(messagesTable.channelId, channelId));
  await db.delete(channelsTable).where(eq(channelsTable.id, channelId));

  res.sendStatus(204);
});

// GET /channels/:channelId/messages
router.get("/channels/:channelId/messages", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const channelId = parseInt(Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId, 10);

  const [channelCheck] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
  if (!channelCheck) { res.status(404).json({ error: "Canal no encontrado" }); return; }
  if (!(await canAccessChannel(channelCheck, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes acceso a este canal" }); return;
  }

  const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined;
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10), 100) : 50;

  const messages = await db
    .select()
    .from(messagesTable)
    .where(
      and(
        eq(messagesTable.channelId, channelId),
        before !== undefined ? lt(messagesTable.id, before) : undefined
      )
    )
    .orderBy(desc(messagesTable.id))
    .limit(limit);

  const reversed = messages.reverse();

  if (reversed.length === 0) { res.json([]); return; }

  // Batch fetch authors, attachments, reactions
  const messageIds = reversed.map(m => m.id);
  const authorIds = [...new Set(reversed.map(m => m.userId))];
  const replyToIds = [...new Set(reversed.map(m => m.replyToId).filter((id): id is number => id != null))];

  const [authors, attachments, rawReactions, replyMessages] = await Promise.all([
    authorIds.length > 0
      ? db.select().from(usersTable).where(inArray(usersTable.id, authorIds))
      : Promise.resolve([] as (typeof usersTable.$inferSelect)[]),
    db.select().from(messageAttachmentsTable).where(inArray(messageAttachmentsTable.messageId, messageIds)),
    db.select({ emoji: messageReactionsTable.emoji, userId: messageReactionsTable.userId, messageId: messageReactionsTable.messageId })
      .from(messageReactionsTable)
      .where(inArray(messageReactionsTable.messageId, messageIds)),
    replyToIds.length > 0
      ? db.select().from(messagesTable).where(inArray(messagesTable.id, replyToIds))
      : Promise.resolve([] as (typeof messagesTable.$inferSelect)[]),
  ]);

  // Build reply author map
  const replyAuthorIds = [...new Set(replyMessages.map(m => m.userId))];
  const replyAuthors = replyAuthorIds.length > 0
    ? await db.select().from(usersTable).where(inArray(usersTable.id, replyAuthorIds))
    : [];

  const authorMap = new Map(authors.map(a => [a.id, a]));
  const replyAuthorMap = new Map(replyAuthors.map(a => [a.id, a]));
  const attachmentMap = new Map<number, typeof attachments>();
  const reactionMap = new Map<number, Array<{ emoji: string; userId: number }>>();
  const replyMap = new Map(replyMessages.map(m => [m.id, m]));

  for (const a of attachments) {
    if (a.messageId === null) continue;
    if (!attachmentMap.has(a.messageId)) attachmentMap.set(a.messageId, []);
    attachmentMap.get(a.messageId)!.push(a);
  }
  for (const r of rawReactions) {
    if (!reactionMap.has(r.messageId)) reactionMap.set(r.messageId, []);
    reactionMap.get(r.messageId)!.push({ emoji: r.emoji, userId: r.userId });
  }

  const result = await Promise.all(
    reversed.map(async (msg) => {
      const author = authorMap.get(msg.userId);
      let content = "[mensaje eliminado]";
      if (!msg.deletedAt) {
        try { content = await decryptChannelMessage(msg); } catch { content = "[error al descifrar]"; }
      }

      // Build replyTo preview
      let replyTo: { id: number; authorDisplayName: string; contentPreview: string } | null = null;
      if (msg.replyToId) {
        const rMsg = replyMap.get(msg.replyToId);
        if (rMsg) {
          const rAuthor = replyAuthorMap.get(rMsg.userId);
          let rContent = "[mensaje eliminado]";
          if (!rMsg.deletedAt) {
            try { rContent = await decryptChannelMessage(rMsg); } catch { rContent = "[error al descifrar]"; }
          }
          replyTo = {
            id: rMsg.id,
            authorDisplayName: rAuthor?.displayName ?? "Usuario",
            contentPreview: rContent.slice(0, 100),
          };
        }
      }

      // Link preview — only for non-deleted messages (fire-and-forget cached)
      let linkPreview = null;
      if (!msg.deletedAt && content) {
        linkPreview = await fetchFirstLinkPreview(content);
      }

      return buildMessageResponse(
        msg,
        content,
        author,
        attachmentMap.get(msg.id) ?? [],
        reactionMap.get(msg.id) ?? [],
        replyTo,
        linkPreview,
      );
    })
  );

  res.json(result);
});

// POST /channels/:channelId/messages
router.post("/channels/:channelId/messages", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const channelId = parseInt(Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId, 10);
  const { content, replyToId, attachmentIds } = req.body;

  const [channelCheck] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
  if (!channelCheck) { res.status(404).json({ error: "Canal no encontrado" }); return; }
  if (!(await canAccessChannel(channelCheck, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes acceso a este canal" }); return;
  }

  // Check if user is muted in this server
  if (channelCheck.serverId) {
    const { pool } = await import("@workspace/db");
    const muteClient = await pool.connect();
    try {
      const muteResult = await muteClient.query(
        `SELECT expires_at, reason FROM server_mutes WHERE server_id=$1 AND user_id=$2 AND expires_at > NOW()`,
        [channelCheck.serverId, userId]
      );
      if (muteResult.rows.length > 0) {
        const row = muteResult.rows[0];
        const expiresAt = new Date(row.expires_at);
        const expiresStr = expiresAt.toLocaleString('es-ES', { hour: '2-digit', minute: '2-digit' });
        res.status(403).json({ error: `Estás silenciado hasta ${expiresStr}${row.reason ? ` — ${row.reason}` : ''}`, muted: true, expiresAt: row.expires_at });
        return;
      }
    } finally {
      muteClient.release();
    }
  }

  const requestedAttachmentIds = Array.isArray(attachmentIds)
    ? [...new Set(attachmentIds.map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 10)
    : [];
  const hasAttachments = requestedAttachmentIds.length > 0;
  if ((content == null || typeof content !== "string" || content.trim().length === 0) && !hasAttachments) {
    res.status(400).json({ error: "El mensaje debe tener contenido o adjuntos" }); return;
  }

  const safeContent = content?.trim() ?? "";
  const { encrypted, iv } = encryptMessage(safeContent || " "); // encrypt a space if no text content

  // Validate replyToId
  let validReplyToId: number | null = null;
  if (replyToId) {
    const [replyMsg] = await db.select().from(messagesTable).where(eq(messagesTable.id, replyToId));
    if (replyMsg && replyMsg.channelId === channelId) validReplyToId = replyToId;
  }

  let msg: typeof messagesTable.$inferSelect;
  let attachmentRows: Array<typeof messageAttachmentsTable.$inferSelect>;
  try {
    ({ msg, attachmentRows } = await db.transaction(async tx => {
      const [createdMessage] = await tx
        .insert(messagesTable)
        .values({ channelId, userId, contentEncrypted: encrypted, iv, replyToId: validReplyToId })
        .returning();

      const claimedAttachments = hasAttachments
        ? await tx.update(messageAttachmentsTable)
          .set({ messageId: createdMessage.id, claimed: true })
          .where(and(
            inArray(messageAttachmentsTable.id, requestedAttachmentIds),
            eq(messageAttachmentsTable.uploadedByUserId, userId),
            eq(messageAttachmentsTable.channelId, channelId),
            eq(messageAttachmentsTable.claimed, false),
            isNull(messageAttachmentsTable.messageId),
          ))
          .returning()
        : [];

      if (!safeContent && claimedAttachments.length === 0) {
        throw new AttachmentClaimError();
      }

      return { msg: createdMessage, attachmentRows: claimedAttachments };
    }));
  } catch (error) {
    if (error instanceof AttachmentClaimError) {
      res.status(409).json({ error: "Los adjuntos ya no están disponibles" });
      return;
    }
    throw error;
  }

  const [author] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

  // Build replyTo preview
  let replyTo: { id: number; authorDisplayName: string; contentPreview: string } | null = null;
  if (validReplyToId) {
    const [rMsg] = await db.select().from(messagesTable).where(eq(messagesTable.id, validReplyToId));
    if (rMsg) {
      const [rAuthor] = await db.select().from(usersTable).where(eq(usersTable.id, rMsg.userId));
      let rContent = "[mensaje eliminado]";
      if (!rMsg.deletedAt) {
        try { rContent = await decryptChannelMessage(rMsg); } catch { /* preserve existing fallback */ }
      }
      replyTo = {
        id: rMsg.id,
        authorDisplayName: rAuthor?.displayName ?? "Usuario",
        contentPreview: rContent.slice(0, 100),
      };
    }
  }

  // Link preview (non-blocking — fire and forget inline since it's cached)
  let linkPreview = null;
  if (safeContent) {
    linkPreview = await fetchFirstLinkPreview(safeContent);
  }

  const responseMsg = await buildMessageResponse(
    msg,
    safeContent,
    author,
    attachmentRows,
    [],
    replyTo,
    linkPreview,
  );

  const { broadcast, broadcastToUser } = await import("../lib/websocket");
  broadcast(`channel:${channelId}`, { type: "message:new", data: responseMsg });

  // @mention detection — notify mentioned users via WS
  if (safeContent) {
    const mentionMatches = safeContent.match(/@(\w+)/g);
    if (mentionMatches && channelCheck.serverId) {
      const usernames = [...new Set(mentionMatches.map((m: string) => m.slice(1).toLowerCase()))];
      try {
        const { pool } = await import("@workspace/db");
        const mentionClient = await pool.connect();
        try {
          for (const username of usernames) {
            const userRes = await mentionClient.query(
              `SELECT u.id FROM users u JOIN server_members sm ON sm.user_id=u.id WHERE u.username=$1 AND sm.server_id=$2`,
              [username, channelCheck.serverId]
            );
            if (userRes.rows[0]) {
              const mentionedId = userRes.rows[0].id;
              if (mentionedId !== userId) {
                broadcastToUser(mentionedId, {
                  type: "mention:new",
                  data: {
                    messageId: responseMsg.id,
                    channelId,
                    serverId: channelCheck.serverId,
                    authorName: responseMsg.author?.displayName ?? "Usuario",
                    preview: safeContent.slice(0, 80),
                  }
                });
              }
            }
          }
        } finally {
          mentionClient.release();
        }
      } catch { /* mention delivery is best-effort */ }
    }
  }

  res.status(201).json(responseMsg);
});

// PATCH /channels/:channelId/messages/:messageId
router.patch(
  "/channels/:channelId/messages/:messageId",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const channelId = parseInt(Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId, 10);
    const messageId = parseInt(Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId, 10);
    const { content } = req.body;

    if (content == null || typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ error: "El contenido del mensaje no puede estar vacío" }); return;
    }

    const [channelCheck] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
    if (!channelCheck) { res.status(404).json({ error: "Canal no encontrado" }); return; }
    if (!(await canAccessChannel(channelCheck, userId, req.session.userRole))) {
      res.status(403).json({ error: "No tienes acceso a este canal" }); return;
    }

    const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
    if (!msg || msg.channelId !== channelId) {
      res.status(404).json({ error: "Mensaje no encontrado" }); return;
    }
    if (msg.userId !== userId && req.session.userRole !== "admin") {
      res.status(403).json({ error: "No puedes editar este mensaje" }); return;
    }

    const { encrypted, iv } = encryptMessage(content);
    const [updated] = await db
      .update(messagesTable)
      .set({ contentEncrypted: encrypted, iv, editedAt: new Date() })
      .where(eq(messagesTable.id, messageId))
      .returning();

    const [author] = await db.select().from(usersTable).where(eq(usersTable.id, updated.userId));

    const [attachmentRows, rawReactions] = await Promise.all([
      db.select().from(messageAttachmentsTable).where(eq(messageAttachmentsTable.messageId, messageId)),
      db.select({ emoji: messageReactionsTable.emoji, userId: messageReactionsTable.userId })
        .from(messageReactionsTable)
        .where(eq(messageReactionsTable.messageId, messageId)),
    ]);

    let linkPreview = null;
    if (content) linkPreview = await fetchFirstLinkPreview(content);

    // Preserve reply context if the message had a replyToId
    let replyPreview: { id: number; authorDisplayName: string; contentPreview: string } | null = null;
    if (updated.replyToId) {
      const [replyMsg] = await db.select().from(messagesTable).where(eq(messagesTable.id, updated.replyToId));
      if (replyMsg) {
        const [replyAuthor] = await db.select().from(usersTable).where(eq(usersTable.id, replyMsg.userId));
        const replyContent = await decryptChannelMessage(replyMsg);
        replyPreview = {
          id: replyMsg.id,
          authorDisplayName: replyAuthor?.displayName ?? "Usuario",
          contentPreview: replyContent.slice(0, 100),
        };
      }
    }

    const responseMsg = await buildMessageResponse(
      updated, content, author, attachmentRows, rawReactions, replyPreview, linkPreview,
    );

    const { broadcast } = await import("../lib/websocket");
    broadcast(`channel:${channelId}`, { type: "message:edit", data: responseMsg });

    res.json(responseMsg);
  }
);

// DELETE /channels/:channelId/messages/:messageId
router.delete(
  "/channels/:channelId/messages/:messageId",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const channelId = parseInt(Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId, 10);
    const messageId = parseInt(Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId, 10);

    const [channelForDelete] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
    if (!channelForDelete) { res.status(404).json({ error: "Canal no encontrado" }); return; }
    if (!(await canAccessChannel(channelForDelete, userId, req.session.userRole))) {
      res.status(403).json({ error: "No tienes acceso a este canal" }); return;
    }

    const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
    if (!msg || msg.channelId !== channelId) {
      res.status(404).json({ error: "Mensaje no encontrado" }); return;
    }

    if (msg.userId !== userId && req.session.userRole !== "admin") {
      const perms = await getMemberPermissions(channelForDelete.serverId, userId);
      if (!hasPerm(perms, PERM.MANAGE_MESSAGES)) {
        res.status(403).json({ error: "No puedes eliminar este mensaje" }); return;
      }
    }

    await db.update(messagesTable)
      .set({ deletedAt: new Date() })
      .where(eq(messagesTable.id, messageId));

    const { broadcast } = await import("../lib/websocket");
    broadcast(`channel:${channelId}`, { type: "message:delete", data: { id: messageId, channelId } });

    res.sendStatus(204);
  }
);

export default router;
