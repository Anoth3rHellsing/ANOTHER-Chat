import { pgTable, text, serial, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const serversTable = pgTable("servers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  iconUrl: text("icon_url"),
  bannerUrl: text("banner_url"),
  isGeneral: boolean("is_general").notNull().default(false),
  ownerId: integer("owner_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const serverMembersTable = pgTable("server_members", {
  id: serial("id").primaryKey(),
  serverId: integer("server_id").notNull(),
  userId: integer("user_id").notNull(),
  role: text("role").notNull().default("member"), // owner | admin | member
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
});

// Custom roles per server (Discord-style)
export const serverRolesTable = pgTable("server_roles", {
  id: serial("id").primaryKey(),
  serverId: integer("server_id").notNull(),
  name: text("name").notNull(),
  color: text("color").notNull().default("#6366f1"), // hex color
  // Integer bitmask: 1=manage_channels, 2=kick_members, 4=ban_members, 8=manage_messages
  permissions: integer("permissions").notNull().default(0),
  position: integer("position").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Junction: which custom roles a server member has
export const serverMemberRolesTable = pgTable("server_member_roles", {
  id: serial("id").primaryKey(),
  memberId: integer("member_id").notNull(), // FK → server_members.id
  roleId: integer("role_id").notNull(),     // FK → server_roles.id
});

// Per-server invite codes (distinct from app-access invite codes)
export const serverInvitesTable = pgTable("server_invites", {
  id: serial("id").primaryKey(),
  serverId: integer("server_id").notNull(),
  code: text("code").notNull().unique(),
  createdById: integer("created_by_id").notNull(),
  usedById: integer("used_by_id"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revoked: boolean("revoked").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertServerSchema = createInsertSchema(serversTable).omit({
  id: true,
  createdAt: true,
});

export const insertServerMemberSchema = createInsertSchema(serverMembersTable).omit({
  id: true,
  joinedAt: true,
});

export const insertServerRoleSchema = createInsertSchema(serverRolesTable).omit({
  id: true,
  createdAt: true,
});

export const insertServerInviteSchema = createInsertSchema(serverInvitesTable).omit({
  id: true,
  createdAt: true,
});

export type InsertServer = z.infer<typeof insertServerSchema>;
export type Server = typeof serversTable.$inferSelect;
export type InsertServerMember = z.infer<typeof insertServerMemberSchema>;
export type ServerMember = typeof serverMembersTable.$inferSelect;
export type InsertServerRole = z.infer<typeof insertServerRoleSchema>;
export type ServerRole = typeof serverRolesTable.$inferSelect;
export type ServerMemberRole = typeof serverMemberRolesTable.$inferSelect;
export type ServerInvite = typeof serverInvitesTable.$inferSelect;
export type InsertServerInvite = z.infer<typeof insertServerInviteSchema>;
