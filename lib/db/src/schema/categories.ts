import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";
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
}, (t) => [
  index("channel_categories_server_position_idx").on(t.serverId, t.position),
]);

export type ChannelCategory = typeof channelCategoriesTable.$inferSelect;
export type NewChannelCategory = typeof channelCategoriesTable.$inferInsert;