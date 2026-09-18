import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
export const channels = pgTable("channels", { id: serial().primaryKey().notNull(), serverId: integer("server_id").notNull(), name: text().notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(), restrictedRoles: text("restricted_roles").default("[]").notNull(), channelType: text("channel_type").default("text").notNull(), visualConfig: text("visual_config").default("{}").notNull() });
export const channelsTable = channels;
export const insertChannelSchema = createInsertSchema(channelsTable).omit({ id: true, createdAt: true });
export type InsertChannel = z.infer<typeof insertChannelSchema>;
export type Channel = typeof channelsTable.$inferSelect;