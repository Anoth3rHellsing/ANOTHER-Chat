import { eq } from "drizzle-orm";
import { db, serversTable, serverMembersTable, usersTable } from "@workspace/db";
import { logger } from "./logger";

/**
 * Ensures the General server exists. Called once at startup.
 * If no general server exists, creates one and adds all existing users.
 * The general server owner is the first admin user found, or user id 1.
 */
export async function ensureGeneralServer(): Promise<void> {
  const [existing] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.isGeneral, true));

  if (existing) {
    // Ensure all users are members (catch users created before this logic existed)
    const allUsers = await db.select({ id: usersTable.id }).from(usersTable);
    const members = await db
      .select({ userId: serverMembersTable.userId })
      .from(serverMembersTable)
      .where(eq(serverMembersTable.serverId, existing.id));

    const memberSet = new Set(members.map((m) => m.userId));
    const missing = allUsers.filter((u) => !memberSet.has(u.id));

    if (missing.length > 0) {
      await db.insert(serverMembersTable).values(
        missing.map((u) => ({ serverId: existing.id, userId: u.id, role: "member" as const }))
      );
      logger.info({ count: missing.length }, "Added existing users to General server");
    }
    return;
  }

  // Find the first admin user to be the owner
  const [adminUser] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.role, "admin"));

  if (!adminUser) {
    logger.info("No users yet — General server will be created on first registration");
    return;
  }

  const [generalServer] = await db
    .insert(serversTable)
    .values({
      name: "General",
      ownerId: adminUser.id,
      isGeneral: true,
    })
    .returning();

  logger.info({ serverId: generalServer.id }, "Created General server");

  // Add all users as members
  const allUsers = await db.select({ id: usersTable.id }).from(usersTable);
  if (allUsers.length > 0) {
    await db.insert(serverMembersTable).values(
      allUsers.map((u) => ({
        serverId: generalServer.id,
        userId: u.id,
        role: u.id === adminUser.id ? ("owner" as const) : ("member" as const),
      }))
    );
    logger.info({ count: allUsers.length }, "Added all users to General server");
  }
}
