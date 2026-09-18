import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { users } from "./introspected";
export const usersTable = users;
export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;