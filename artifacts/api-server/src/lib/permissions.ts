import { eq, and } from "drizzle-orm";
import {
  db,
  channelsTable,
  serverMembersTable,
  serverMemberRolesTable,
  serverRolesTable,
} from "@workspace/db";

/** Permission bit flags */
export const PERM = {
  MANAGE_CHANNELS: 1,
  KICK_MEMBERS: 2,
  BAN_MEMBERS: 4,
  MANAGE_MESSAGES: 8,
} as const;

/** All permissions granted — used for owner/admin shortcut */
const ALL_PERMS = 0xffffffff;

/** Returns true if `permissions` includes the given flag */
export function hasPerm(permissions: number, flag: number): boolean {
  return (permissions & flag) === flag;
}

/**
 * Returns the effective permission bitmask for a user in a server.
 * Owners and server-admins receive ALL_PERMS automatically.
 * For regular members it is the union of all their custom role permissions.
 * Returns 0 when the user is not a member.
 */
export async function getMemberPermissions(
  serverId: number,
  userId: number
): Promise<number> {
  const [membership] = await db
    .select()
    .from(serverMembersTable)
    .where(
      and(
        eq(serverMembersTable.serverId, serverId),
        eq(serverMembersTable.userId, userId)
      )
    );

  if (!membership) return 0;

  // Owners and admins always have all permissions
  if (membership.role === "owner" || membership.role === "admin") {
    return ALL_PERMS;
  }

  // Union of all custom role permissions
  const memberRoles = await db
    .select({ permissions: serverRolesTable.permissions })
    .from(serverMemberRolesTable)
    .innerJoin(
      serverRolesTable,
      eq(serverMemberRolesTable.roleId, serverRolesTable.id)
    )
    .where(eq(serverMemberRolesTable.memberId, membership.id));

  return memberRoles.reduce((acc, mr) => acc | (mr.permissions ?? 0), 0);
}

/**
 * Returns the full membership row for a user in a server, or null.
 */
export async function getMembership(serverId: number, userId: number) {
  const [membership] = await db
    .select()
    .from(serverMembersTable)
    .where(
      and(
        eq(serverMembersTable.serverId, serverId),
        eq(serverMembersTable.userId, userId)
      )
    );
  return membership ?? null;
}

/**
 * Returns the role IDs assigned to a member.
 */
export async function getMemberRoleIds(memberId: number): Promise<number[]> {
  const rows = await db
    .select({ roleId: serverMemberRolesTable.roleId })
    .from(serverMemberRolesTable)
    .where(eq(serverMemberRolesTable.memberId, memberId));
  return rows.map((r) => r.roleId);
}

/** Parse the restrictedRoles JSON string stored in the channel row */
export function parseRestrictedRoles(raw: string): number[] {
  try {
    return JSON.parse(raw) as number[];
  } catch {
    return [];
  }
}

/**
 * Returns true when a user may access a channel.
 *
 * Authorization order (membership check MUST come before the unrestricted short-circuit):
 * 1. Global admin always passes.
 * 2. User must be a server member.
 * 3. Server owner / server-admin always passes.
 * 4. If channel has no role restrictions, any member passes.
 * 5. Member must hold at least one of the channel's required roles.
 */
export async function canAccessChannel(
  channel: { restrictedRoles: string; serverId: number },
  userId: number,
  globalRole: string | undefined
): Promise<boolean> {
  if (globalRole === "admin") return true;

  const membership = await getMembership(channel.serverId, userId);
  if (!membership) return false;

  if (membership.role === "owner" || membership.role === "admin") return true;

  const restricted = parseRestrictedRoles(channel.restrictedRoles);
  if (restricted.length === 0) return true;

  const memberRoleIds = await getMemberRoleIds(membership.id);
  return memberRoleIds.some((id) => restricted.includes(id));
}
