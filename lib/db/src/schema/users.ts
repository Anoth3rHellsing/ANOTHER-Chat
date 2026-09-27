import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { pgTable, unique, serial, text, boolean, timestamp, varchar, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
export const users = pgTable("users", { id: serial().primaryKey().notNull(), username: text().notNull(), passwordHash: text("password_hash").notNull(), displayName: text("display_name").notNull(), bio: text().default(""), avatarUrl: text("avatar_url"), bannerUrl: text("banner_url"), status: text().default("offline").notNull(), role: text().default("member").notNull(), banned: boolean().default(false).notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(), socialLinks: text("social_links").default("[]").notNull(), customStatus: text("custom_status"), statusEmoji: varchar("status_emoji", { length: 20 }), lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: "date" }), invisible: boolean().default(false).notNull() }, t => [
  index("users_avatar_url_canonical_idx").using("btree", sql`(CASE WHEN ${t.avatarUrl} ~ '^https?://' THEN regexp_replace(${t.avatarUrl}, '^https?://[^/]+', '') ELSE ${t.avatarUrl} END)`),
  index("users_banner_url_canonical_idx").using("btree", sql`(CASE WHEN ${t.bannerUrl} ~ '^https?://' THEN regexp_replace(${t.bannerUrl}, '^https?://[^/]+', '') ELSE ${t.bannerUrl} END)`),
  unique("users_username_unique").on(t.username),
]);
export const usersTable = users;
export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;