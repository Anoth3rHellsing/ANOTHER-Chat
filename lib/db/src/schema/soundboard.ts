import { pgTable, serial, integer, text, timestamp, foreignKey, index } from "drizzle-orm/pg-core";
import { servers } from "./servers";
import { users } from "./users";

export const soundboardClips = pgTable("soundboard_clips", {
  id: serial().primaryKey().notNull(),
  serverId: integer("server_id").notNull(),
  name: text().notNull(),
  durationMs: integer("duration_ms").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  mimeType: text("mime_type").notNull(),
  url: text().notNull(),
  uploadedBy: integer("uploaded_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, (t) => [
  index("soundboard_clips_server_id_idx").using("btree", t.serverId.asc().nullsLast()),
  foreignKey({ columns: [t.serverId], foreignColumns: [servers.id], name: "soundboard_clips_server_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.uploadedBy], foreignColumns: [users.id], name: "soundboard_clips_uploaded_by_fkey" }).onDelete("cascade"),
]);

export const soundboardClipsTable = soundboardClips;
export type SoundboardClip = typeof soundboardClips.$inferSelect;