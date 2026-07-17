import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const channelsTable = pgTable("channels", {
  id: serial("id").primaryKey(),
  serverId: integer("server_id").notNull(),
  name: text("name").notNull(),
  // text | voice | media
  channelType: text("channel_type").notNull().default("text"),
  // JSON-encoded array of server_role IDs that can access this channel.
  // Empty array ("[]") means everyone can see it.
  restrictedRoles: text("restricted_roles").notNull().default("[]"),
  // JSON: { kind: 'gradient'|'image', value: string }
  // gradient value: "from-color,to-color" (two hex codes)
  // image value: URL string
  visualConfig: text("visual_config").notNull().default("{}"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertChannelSchema = createInsertSchema(channelsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertChannel = z.infer<typeof insertChannelSchema>;
export type Channel = typeof channelsTable.$inferSelect;
