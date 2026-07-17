import { Router, type IRouter } from "express";
import { eq, and, lt, desc } from "drizzle-orm";
import {
  db,
  channelsTable,
  messagesTable,
  serverMembersTable,
  serversTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { encryptMessage, decryptMessage } from "../lib/crypto";

const router: IRouter = Router();

// GET /servers/:serverId/channels
router.get("/servers/:serverId/channels", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const serverId = parseInt(raw, 10);

  const channels = await db
    .select()
    .from(channelsTable)
    .where(eq(channelsTable.serverId, serverId));

  res.json(
    channels.map((c) => ({
      id: c.id,
      serverId: c.serverId,
      name: c.name,
      createdAt: c.createdAt,
    }))
  );
});

// POST /servers/:serverId/channels
router.post("/servers/:serverId/channels", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const raw = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const serverId = parseInt(raw, 10);
  const { name } = req.body;

  if (!name) {
    res.status(400).json({ error: "El nombre del canal es requerido" });
    return;
  }

  // Must be member with admin/owner role or global admin
  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) {
    res.status(404).json({ error: "Servidor no encontrado" });
    return;
  }

  const [membership] = await db
    .select()
    .from(serverMembersTable)
    .where(
      and(eq(serverMembersTable.serverId, serverId), eq(serverMembersTable.userId, userId))
    );

  const isAllowed =
    req.session.userRole === "admin" ||
    (membership && ["owner", "admin"].includes(membership.role));

  if (!isAllowed) {
    res.status(403).json({ error: "No tienes permiso para crear canales" });
    return;
  }

  const [channel] = await db
    .insert(channelsTable)
    .values({ serverId, name })
    .returning();

  res.status(201).json({
    id: channel.id,
    serverId: channel.serverId,
    name: channel.name,
    createdAt: channel.createdAt,
  });
});

// DELETE /channels/:channelId
router.delete("/channels/:channelId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const raw = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;
  const channelId = parseInt(raw, 10);

  const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
  if (!channel) {
    res.status(404).json({ error: "Canal no encontrado" });
    return;
  }

  const [membership] = await db
    .select()
    .from(serverMembersTable)
    .where(
      and(
        eq(serverMembersTable.serverId, channel.serverId),
        eq(serverMembersTable.userId, userId)
      )
    );

  const isAllowed =
    req.session.userRole === "admin" ||
    (membership && ["owner", "admin"].includes(membership.role));

  if (!isAllowed) {
    res.status(403).json({ error: "No tienes permiso para eliminar canales" });
    return;
  }

  await db.delete(messagesTable).where(eq(messagesTable.channelId, channelId));
  await db.delete(channelsTable).where(eq(channelsTable.id, channelId));

  res.sendStatus(204);
});

// GET /channels/:channelId/messages
router.get("/channels/:channelId/messages", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;
  const channelId = parseInt(raw, 10);
  const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined;
  const limit = req.query.limit ? Math.min(parseInt(req.query.limit as string, 10), 100) : 50;

  let query = db
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

  const messages = await query;

  const result = await Promise.all(
    messages.reverse().map(async (msg) => {
      const [author] = await db.select().from(usersTable).where(eq(usersTable.id, msg.userId));

      let content = "[mensaje eliminado]";
      if (!msg.deletedAt) {
        try {
          content = decryptMessage(msg.contentEncrypted, msg.iv);
        } catch {
          content = "[error al descifrar]";
        }
      }

      return {
        id: msg.id,
        channelId: msg.channelId,
        userId: msg.userId,
        content,
        editedAt: msg.editedAt,
        deletedAt: msg.deletedAt,
        createdAt: msg.createdAt,
        author: author
          ? {
              id: author.id,
              username: author.username,
              displayName: author.displayName,
              bio: author.bio,
              avatarUrl: author.avatarUrl,
              bannerUrl: author.bannerUrl,
              status: author.status,
              role: author.role,
              createdAt: author.createdAt,
            }
          : null,
      };
    })
  );

  res.json(result);
});

// POST /channels/:channelId/messages
router.post("/channels/:channelId/messages", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const raw = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;
  const channelId = parseInt(raw, 10);
  const { content } = req.body;

  if (content == null || typeof content !== "string" || content.trim().length === 0) {
    res.status(400).json({ error: "El contenido del mensaje no puede estar vacío" });
    return;
  }

  const { encrypted, iv } = encryptMessage(content);

  const [msg] = await db
    .insert(messagesTable)
    .values({ channelId, userId, contentEncrypted: encrypted, iv })
    .returning();

  const [author] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

  const responseMsg = {
    id: msg.id,
    channelId: msg.channelId,
    userId: msg.userId,
    content,
    editedAt: msg.editedAt,
    deletedAt: msg.deletedAt,
    createdAt: msg.createdAt,
    author: {
      id: author.id,
      username: author.username,
      displayName: author.displayName,
      bio: author.bio,
      avatarUrl: author.avatarUrl,
      bannerUrl: author.bannerUrl,
      status: author.status,
      role: author.role,
      createdAt: author.createdAt,
    },
  };

  // Broadcast via WebSocket
  const { broadcast } = await import("../lib/websocket");
  broadcast(`channel:${channelId}`, { type: "message:new", data: responseMsg });

  res.status(201).json(responseMsg);
});

// PATCH /channels/:channelId/messages/:messageId
router.patch(
  "/channels/:channelId/messages/:messageId",
  requireAuth,
  async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const rawCid = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;
    const rawMid = Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId;
    const channelId = parseInt(rawCid, 10);
    const messageId = parseInt(rawMid, 10);
    const { content } = req.body;

    if (content == null || typeof content !== "string" || content.trim().length === 0) {
      res.status(400).json({ error: "El contenido del mensaje no puede estar vacío" });
      return;
    }

    const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));

    if (!msg || msg.channelId !== channelId) {
      res.status(404).json({ error: "Mensaje no encontrado" });
      return;
    }

    if (msg.userId !== userId && req.session.userRole !== "admin") {
      res.status(403).json({ error: "No puedes editar este mensaje" });
      return;
    }

    const { encrypted, iv } = encryptMessage(content);

    const [updated] = await db
      .update(messagesTable)
      .set({ contentEncrypted: encrypted, iv, editedAt: new Date() })
      .where(eq(messagesTable.id, messageId))
      .returning();

    const [author] = await db.select().from(usersTable).where(eq(usersTable.id, updated.userId));

    const responseMsg = {
      id: updated.id,
      channelId: updated.channelId,
      userId: updated.userId,
      content,
      editedAt: updated.editedAt,
      deletedAt: updated.deletedAt,
      createdAt: updated.createdAt,
      author: {
        id: author.id,
        username: author.username,
        displayName: author.displayName,
        bio: author.bio,
        avatarUrl: author.avatarUrl,
        bannerUrl: author.bannerUrl,
        status: author.status,
        role: author.role,
        createdAt: author.createdAt,
      },
    };

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
    const rawCid = Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId;
    const rawMid = Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId;
    const channelId = parseInt(rawCid, 10);
    const messageId = parseInt(rawMid, 10);

    const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));

    if (!msg || msg.channelId !== channelId) {
      res.status(404).json({ error: "Mensaje no encontrado" });
      return;
    }

    if (msg.userId !== userId && req.session.userRole !== "admin") {
      res.status(403).json({ error: "No puedes eliminar este mensaje" });
      return;
    }

    await db
      .update(messagesTable)
      .set({ deletedAt: new Date() })
      .where(eq(messagesTable.id, messageId));

    const { broadcast } = await import("../lib/websocket");
    broadcast(`channel:${channelId}`, { type: "message:delete", data: { id: messageId, channelId } });

    res.sendStatus(204);
  }
);

export default router;
