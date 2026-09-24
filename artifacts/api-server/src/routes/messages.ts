import { Router, type IRouter } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  messagesTable,
  messageAttachmentsTable,
  messageReactionsTable,
  channelsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { canAccessChannel } from "../lib/permissions";
import {
  groupReactions,
  isSingleEmoji,
  MAX_DISTINCT_REACTIONS_PER_MESSAGE,
} from "../lib/reactions";

const router: IRouter = Router();

// ─── Multer for file uploads ──────────────────────────────────────────────────
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ext = path.extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});

/**
 * Strict server-side allowlist.
 * SVG is excluded: it can contain inline script tags and is treated as a
 * download, not an inline image, on the serve side — but excluding it
 * from uploads entirely is simpler and safer.
 */
const ALLOWED_MIMES = new Set([
  // Images (safe inline types only — no SVG)
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  // Video
  "video/mp4",
  "video/webm",
  "video/ogg",
  // Documents (all served as attachment, not inline)
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/zip",
  "text/plain",
]);

/** Extensions that must never be served inline regardless of claimed MIME */
const BLOCKED_EXTENSIONS = new Set([
  ".html", ".htm", ".xhtml", ".xml", ".svg",
  ".js", ".mjs", ".jsx", ".ts", ".tsx",
  ".php", ".py", ".rb", ".sh", ".bash",
  ".exe", ".dll", ".bat", ".cmd",
]);

const INLINE_MIMES = new Set([
  "image/jpeg", "image/png", "image/gif", "image/webp",
  "video/mp4", "video/webm", "video/ogg",
]);

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB outer limit
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXTENSIONS.has(ext)) {
      return cb(new Error(`Tipo de archivo no permitido: ${ext}`));
    }
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return cb(new Error(`MIME type no permitido: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── POST /channels/:channelId/attachments ────────────────────────────────────
router.post(
  "/channels/:channelId/attachments",
  requireAuth,
  upload.single("file"),
  async (req, res): Promise<void> => {
    const userId = req.session.userId!;
    const channelId = parseInt(Array.isArray(req.params.channelId) ? req.params.channelId[0] : req.params.channelId, 10);

    const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
    if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }
    if (!(await canAccessChannel(channel, userId, req.session.userRole))) {
      res.status(403).json({ error: "No tienes acceso a este canal" }); return;
    }

    if (!req.file) { res.status(400).json({ error: "Archivo no recibido" }); return; }

    const file = req.file;
    const isInline = INLINE_MIMES.has(file.mimetype);
    const maxSize = isInline ? 50 * 1024 * 1024 : 25 * 1024 * 1024;

    if (file.size > maxSize) {
      fs.unlink(file.path, () => {});
      res.status(400).json({ error: `Archivo demasiado grande (máx ${isInline ? "50" : "25"}MB)` });
      return;
    }

    const url = `/api/uploads/${file.filename}`;

    const [attachment] = await db.insert(messageAttachmentsTable).values({
      messageId: null,
      uploadedByUserId: userId,
      channelId,
      claimed: false,
      url,
      filename: file.originalname,
      mimeType: file.mimetype,
      size: file.size,
    }).returning();

    res.status(201).json({
      id: attachment.id,
      url: attachment.url,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
    });
  }
);

// ─── POST /messages/:messageId/reactions ──────────────────────────────────────
router.post("/messages/:messageId/reactions", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const messageId = parseInt(Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId, 10);
  const emoji = req.body?.emoji;

  if (!Number.isInteger(messageId) || messageId < 1) {
    res.status(400).json({ error: "ID de mensaje inválido" }); return;
  }
  if (!isSingleEmoji(emoji)) {
    res.status(400).json({ error: "Emoji inválido" }); return;
  }

  const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
  if (!msg || msg.deletedAt) { res.status(404).json({ error: "Mensaje no encontrado" }); return; }

  // Verify channel access
  const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, msg.channelId));
  if (!channel || !(await canAccessChannel(channel, userId, req.session.userRole))) {
    res.status(403).json({ error: "Sin acceso" }); return;
  }

  // Serialize mutations per message; the unique constraint remains a final guard
  // against duplicate (message, user, emoji) rows.
  const result = await db.transaction(async (tx) => {
    const [lockedMessage] = await tx.select({ id: messagesTable.id, deletedAt: messagesTable.deletedAt })
      .from(messagesTable)
      .where(eq(messagesTable.id, messageId))
      .for("update");
    if (!lockedMessage || lockedMessage.deletedAt) return { status: "missing" as const };

    const whereMine = and(
      eq(messageReactionsTable.messageId, messageId),
      eq(messageReactionsTable.userId, userId),
      eq(messageReactionsTable.emoji, emoji),
    );
    const [existing] = await tx.select({ id: messageReactionsTable.id })
      .from(messageReactionsTable)
      .where(whereMine);

    if (existing) {
      await tx.delete(messageReactionsTable).where(eq(messageReactionsTable.id, existing.id));
    } else {
      const rows = await tx.select({ emoji: messageReactionsTable.emoji })
        .from(messageReactionsTable)
        .where(eq(messageReactionsTable.messageId, messageId));
      if (!rows.some((row) => row.emoji === emoji)
          && new Set(rows.map((row) => row.emoji)).size >= MAX_DISTINCT_REACTIONS_PER_MESSAGE) {
        return { status: "limit" as const };
      }
      await tx.insert(messageReactionsTable)
        .values({ messageId, userId, emoji })
        .onConflictDoNothing({
          target: [messageReactionsTable.messageId, messageReactionsTable.userId, messageReactionsTable.emoji],
        });
    }

    const rows = await tx.select({
      emoji: messageReactionsTable.emoji,
      userId: messageReactionsTable.userId,
    }).from(messageReactionsTable).where(eq(messageReactionsTable.messageId, messageId));
    return { status: "ok" as const, reactions: groupReactions(rows) };
  });
  if (result.status === "missing") { res.status(404).json({ error: "Mensaje no encontrado" }); return; }
  if (result.status === "limit") {
    res.status(400).json({ error: "El mensaje ya tiene el máximo de 20 emojis distintos" }); return;
  }
  const reactions = result.reactions;

  // Broadcast via WebSocket
  const { broadcast } = await import("../lib/websocket");
  broadcast(`channel:${msg.channelId}`, {
    type: "message_reaction_update",
    data: { channelId: msg.channelId, messageId, reactions },
  });

  res.json(reactions);
});

// ─── DELETE /messages/:messageId/reactions/:emoji ─────────────────────────────
router.delete("/messages/:messageId/reactions/:emoji", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const messageId = parseInt(Array.isArray(req.params.messageId) ? req.params.messageId[0] : req.params.messageId, 10);
  const emoji = Array.isArray(req.params.emoji) ? req.params.emoji[0] : req.params.emoji;
  if (!Number.isInteger(messageId) || messageId < 1) {
    res.status(400).json({ error: "ID de mensaje inválido" }); return;
  }
  if (!isSingleEmoji(emoji)) {
    res.status(400).json({ error: "Emoji inválido" }); return;
  }

  const [msg] = await db.select().from(messagesTable).where(eq(messagesTable.id, messageId));
  if (!msg || msg.deletedAt) { res.status(404).json({ error: "Mensaje no encontrado" }); return; }

  const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, msg.channelId));
  if (!channel || !(await canAccessChannel(channel, userId, req.session.userRole))) {
    res.status(403).json({ error: "Sin acceso" }); return;
  }

  const result = await db.transaction(async (tx) => {
    const [lockedMessage] = await tx.select({ id: messagesTable.id, deletedAt: messagesTable.deletedAt })
      .from(messagesTable)
      .where(eq(messagesTable.id, messageId))
      .for("update");
    if (!lockedMessage || lockedMessage.deletedAt) return { status: "missing" as const };
    await tx.delete(messageReactionsTable).where(and(
      eq(messageReactionsTable.messageId, messageId),
      eq(messageReactionsTable.userId, userId),
      eq(messageReactionsTable.emoji, emoji),
    ));
    const rows = await tx.select({
      emoji: messageReactionsTable.emoji,
      userId: messageReactionsTable.userId,
    }).from(messageReactionsTable).where(eq(messageReactionsTable.messageId, messageId));
    return { status: "ok" as const, reactions: groupReactions(rows) };
  });
  if (result.status === "missing") { res.status(404).json({ error: "Mensaje no encontrado" }); return; }
  const reactions = result.reactions;

  const { broadcast } = await import("../lib/websocket");
  broadcast(`channel:${msg.channelId}`, {
    type: "message_reaction_update",
    data: { channelId: msg.channelId, messageId, reactions },
  });

  res.json(reactions);
});

export default router;
