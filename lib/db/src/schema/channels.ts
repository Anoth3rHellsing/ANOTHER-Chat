import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { channelCategoriesTable } from "./categories.js";
export const channels = pgTable("channels", { id: serial().primaryKey().notNull(), serverId: integer("server_id").notNull(), name: text().notNull(), createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(), restrictedRoles: text("restricted_roles").default("[]").notNull(), channelType: text("channel_type").default("text").notNull(), visualConfig: text("visual_config").default("{}").notNull(), categoryId: integer("category_id").references(() => channelCategoriesTable.id, { onDelete: "set null" }), position: integer("position").default(0).notNull() });
export const channelsTable = channels;
export const insertChannelSchema = createInsertSchema(channelsTable).omit({ id: true, createdAt: true });
export type InsertChannel = z.infer<typeof insertChannelSchema>;
export type Channel = typeof channelsTable.$inferSelect;