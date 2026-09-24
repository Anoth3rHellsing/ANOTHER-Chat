import { pgTable, serial, integer, text, timestamp, foreignKey, primaryKey, index } from "drizzle-orm/pg-core";
import { users } from "./users";
import { servers } from "./servers";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
export const clips = pgTable("clips", { id: serial().primaryKey().notNull(), serverId: integer("server_id").notNull(), userId: integer("user_id").notNull(), title: text().notNull(), videoUrl: text("video_url").notNull(), thumbnailUrl: text("thumbnail_url"), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull() }, t => [
  index("clips_video_url_canonical_idx").using("btree", sql`(CASE WHEN ${t.videoUrl} ~ '^https?://' THEN regexp_replace(${t.videoUrl}, '^https?://[^/]+', '') ELSE ${t.videoUrl} END)`),
  foreignKey({ columns: [t.serverId], foreignColumns: [servers.id], name: "clips_server_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "clips_user_id_fkey" }).onDelete("cascade"),
]);
export const clipComments = pgTable("clip_comments", { id: serial().primaryKey().notNull(), clipId: integer("clip_id").notNull(), userId: integer("user_id").notNull(), content: text().notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull() }, t => [foreignKey({ columns: [t.clipId], foreignColumns: [clips.id], name: "clip_comments_clip_id_fkey" }).onDelete("cascade"), foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "clip_comments_user_id_fkey" }).onDelete("cascade")]);
export const clipLikes = pgTable("clip_likes", { clipId: integer("clip_id").notNull(), userId: integer("user_id").notNull() }, t => [foreignKey({ columns: [t.clipId], foreignColumns: [clips.id], name: "clip_likes_clip_id_fkey" }).onDelete("cascade"), foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "clip_likes_user_id_fkey" }).onDelete("cascade"), primaryKey({ columns: [t.clipId, t.userId], name: "clip_likes_pkey" })]);
export const clipsTable = clips;
export const clipCommentsTable = clipComments;
export const clipLikesTable = clipLikes;
export const insertClipSchema = createInsertSchema(clips).omit({ id: true, createdAt: true });
export const insertClipCommentSchema = createInsertSchema(clipComments).omit({ id: true, createdAt: true });
export const insertClipLikeSchema = createInsertSchema(clipLikes);
export type Clip = typeof clips.$inferSelect;
export type InsertClip = z.infer<typeof insertClipSchema>;
export type ClipComment = typeof clipComments.$inferSelect;
export type InsertClipComment = z.infer<typeof insertClipCommentSchema>;
export type ClipLike = typeof clipLikes.$inferSelect;
export type InsertClipLike = z.infer<typeof insertClipLikeSchema>;