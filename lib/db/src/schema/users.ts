import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { pgTable, unique, serial, text, boolean, timestamp, varchar } from "drizzle-orm/pg-core";
export const users = pgTable("users", { id: serial().primaryKey().notNull(), username: text().notNull(), passwordHash: text("password_hash").notNull(), displayName: text("display_name").notNull(), bio: text().default(""), avatarUrl: text("avatar_url"), bannerUrl: text("banner_url"), status: text().default("offline").notNull(), role: text().default("member").notNull(), banned: boolean().default(false).notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(), socialLinks: text("social_links").default("[]").notNull(), customStatus: text("custom_status"), statusEmoji: varchar("status_emoji", { length: 20 }) }, t => [unique("users_username_unique").on(t.username)]);
export const usersTable = users;
export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;