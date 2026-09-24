import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { check, foreignKey, index, integer, pgTable, serial, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { channels } from "./channels";
import { users } from "./users";

export const channelEvents = pgTable("channel_events", {
  id: serial().primaryKey().notNull(),
  channelId: integer("channel_id").notNull(),
  creatorId: integer("creator_id").notNull(),
  title: text().notNull(),
  description: text(),
  startsAt: timestamp("starts_at", { withTimezone: true, mode: "date" }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true, mode: "date" }),
  originalTimeZone: text("original_time_zone").notNull(),
  canceledAt: timestamp("canceled_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  index("channel_events_channel_id_starts_at_idx").on(t.channelId, t.startsAt),
  foreignKey({ columns: [t.channelId], foreignColumns: [channels.id], name: "channel_events_channel_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.creatorId], foreignColumns: [users.id], name: "channel_events_creator_id_fkey" }).onDelete("cascade"),
]);

export const eventResponses = pgTable("event_responses", {
  id: serial().primaryKey().notNull(),
  eventId: integer("event_id").notNull(),
  userId: integer("user_id").notNull(),
  status: text().notNull(),
  respondedAt: timestamp("responded_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, t => [
  check("event_responses_status_check", sql`${t.status} in ('yes', 'no', 'maybe')`),
  foreignKey({ columns: [t.eventId], foreignColumns: [channelEvents.id], name: "event_responses_event_id_fkey" }).onDelete("cascade"),
  foreignKey({ columns: [t.userId], foreignColumns: [users.id], name: "event_responses_user_id_fkey" }).onDelete("cascade"),
  unique("event_responses_event_id_user_id_key").on(t.eventId, t.userId),
]);

export const channelEventsTable = channelEvents;
export const eventResponsesTable = eventResponses;
export const insertChannelEventSchema = createInsertSchema(channelEventsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertEventResponseSchema = createInsertSchema(eventResponsesTable).omit({ id: true, respondedAt: true, updatedAt: true });
export type InsertChannelEvent = z.infer<typeof insertChannelEventSchema>;
export type ChannelEvent = typeof channelEventsTable.$inferSelect;
export type InsertEventResponse = z.infer<typeof insertEventResponseSchema>;
export type EventResponse = typeof eventResponsesTable.$inferSelect;