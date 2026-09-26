import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";
import { serversTable } from "./servers.js";

export const channelCategoriesTable = pgTable("channel_categories", {
  id: serial("id").primaryKey(),
  serverId: integer("server_id")
    .notNull()
    .references(() => serversTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  position: integer("position").default(0).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .defaultNow()
    .notNull(),
});

export type ChannelCategory = typeof channelCategoriesTable.$inferSelect;
export type NewChannelCategory = typeof channelCategoriesTable.$inferInsert;