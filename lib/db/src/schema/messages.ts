import { pgTable, text, serial, integer, timestamp, unique, primaryKey } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const messagesTable = pgTable("messages", {
  id: serial("id").primaryKey(),
  channelId: integer("channel_id").notNull(),
  userId: integer("user_id").notNull(),
  contentEncrypted: text("content_encrypted").notNull(),
  iv: text("iv").notNull(), // AES-256-CBC initialization vector
  replyToId: integer("reply_to_id"), // nullable FK to messages.id
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messageAttachmentsTable = pgTable("message_attachments", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull(),
  uploadedByUserId: integer("uploaded_by_user_id"),
  channelId: integer("channel_id"),
  claimed: integer("claimed").notNull().default(0), // 0=unclaimed, 1=claimed
  url: text("url").notNull(),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messageReactionsTable = pgTable("message_reactions", {
  id: serial("id").primaryKey(),
  messageId: integer("message_id").notNull(),
  userId: integer("user_id").notNull(),
  emoji: text("emoji").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("message_reactions_unique").on(t.messageId, t.userId, t.emoji),
]);

// ─── Direct Messages ──────────────────────────────────────────────────────────

export const directMessagesTable = pgTable("direct_messages", {
  id: serial("id").primaryKey(),
  senderId: integer("sender_id").notNull(),
  recipientId: integer("recipient_id").notNull(),
  contentEncrypted: text("content_encrypted").notNull(),
  iv: text("iv").notNull(),
  replyToId: integer("reply_to_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const dmReadCursorsTable = pgTable("dm_read_cursors", {
  userId: integer("user_id").notNull(),
  otherUserId: integer("other_user_id").notNull(),
  lastReadAt: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.userId, t.otherUserId] }),
]);

export type DirectMessage = typeof directMessagesTable.$inferSelect;
export type DmReadCursor = typeof dmReadCursorsTable.$inferSelect;

export const insertMessageSchema = createInsertSchema(messagesTable).omit({
  id: true,
  editedAt: true,
  deletedAt: true,
  createdAt: true,
});

export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type Message = typeof messagesTable.$inferSelect;
export type MessageAttachment = typeof messageAttachmentsTable.$inferSelect;
export type MessageReaction = typeof messageReactionsTable.$inferSelect;
