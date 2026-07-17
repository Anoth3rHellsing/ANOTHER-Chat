import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const inviteCodesTable = pgTable("invite_codes", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  generatedById: integer("generated_by_id").notNull(),
  usedById: integer("used_by_id"),
  usedAt: timestamp("used_at", { withTimezone: true }),
  revoked: boolean("revoked").notNull().default(false),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertInviteCodeSchema = createInsertSchema(inviteCodesTable).omit({
  id: true,
  createdAt: true,
});

export type InsertInviteCode = z.infer<typeof insertInviteCodeSchema>;
export type InviteCode = typeof inviteCodesTable.$inferSelect;
