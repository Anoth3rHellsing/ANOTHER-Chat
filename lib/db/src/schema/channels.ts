import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { channels } from "./introspected";
export const channelsTable = channels;
export const insertChannelSchema = createInsertSchema(channelsTable).omit({ id: true, createdAt: true });
export type InsertChannel = z.infer<typeof insertChannelSchema>;
export type Channel = typeof channelsTable.$inferSelect;