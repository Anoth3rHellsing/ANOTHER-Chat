import { pgTable, text, serial, integer, timestamp, unique } from "drizzle-orm/pg-core";
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
