import { Router, type IRouter } from "express";
import { eq, count } from "drizzle-orm";
import crypto from "crypto";
import {
  db,
  usersTable,
  inviteCodesTable,
  messagesTable,
  serversTable,
  serverMembersTable,
} from "@workspace/db";
import { requireAdmin } from "../lib/auth";

const router: IRouter = Router();

// GET /admin/invites
router.get("/admin/invites", requireAdmin, async (req, res): Promise<void> => {
  const invites = await db.select().from(inviteCodesTable).orderBy(inviteCodesTable.createdAt);
  res.json(
    invites.map((i) => ({
      code: i.code,
      generatedById: i.generatedById,
      usedById: i.usedById,
      revoked: i.revoked,
      createdAt: i.createdAt,
      usedAt: i.usedAt,
    }))
  );
});

// POST /admin/invites
router.post("/admin/invites", requireAdmin, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const { note } = req.body ?? {};

  const code = crypto.randomBytes(6).toString("hex").toUpperCase(); // e.g. A3F8C1D2

  const [invite] = await db
    .insert(inviteCodesTable)
    .values({ code, generatedById: userId, note: note ?? null })
    .returning();

  res.status(201).json({
    code: invite.code,
    generatedById: invite.generatedById,
    usedById: invite.usedById,
    revoked: invite.revoked,
    createdAt: invite.createdAt,
    usedAt: invite.usedAt,
  });
});

// DELETE /admin/invites/:code
router.delete("/admin/invites/:code", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;

  const [invite] = await db
    .select()
    .from(inviteCodesTable)
    .where(eq(inviteCodesTable.code, raw));

  if (!invite) {
    res.status(404).json({ error: "Código de invitación no encontrado" });
    return;
  }

  await db
    .update(inviteCodesTable)
    .set({ revoked: true })
    .where(eq(inviteCodesTable.code, raw));

  res.sendStatus(204);
});

// GET /admin/users
router.get("/admin/users", requireAdmin, async (_req, res): Promise<void> => {
  const users = await db.select().from(usersTable).orderBy(usersTable.createdAt);
  res.json(
    users.map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      status: u.status,
      role: u.role,
      banned: u.banned,
      avatarUrl: u.avatarUrl,
      createdAt: u.createdAt,
    }))
  );
});

// POST /admin/users/:userId/kick
router.post("/admin/users/:userId/kick", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const targetId = parseInt(raw, 10);

  // Remove from all servers
  await db.delete(serverMembersTable).where(eq(serverMembersTable.userId, targetId));

  // Set offline
  await db.update(usersTable).set({ status: "offline" }).where(eq(usersTable.id, targetId));

  res.sendStatus(204);
});

// POST /admin/users/:userId/ban
router.post("/admin/users/:userId/ban", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const targetId = parseInt(raw, 10);

  await db.update(usersTable).set({ banned: true, status: "offline" }).where(eq(usersTable.id, targetId));

  // Remove from all servers
  await db.delete(serverMembersTable).where(eq(serverMembersTable.userId, targetId));

  res.sendStatus(204);
});

// POST /admin/users/:userId/unban
router.post("/admin/users/:userId/unban", requireAdmin, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const targetId = parseInt(raw, 10);

  await db.update(usersTable).set({ banned: false }).where(eq(usersTable.id, targetId));

  res.sendStatus(204);
});

// GET /admin/stats
router.get("/admin/stats", requireAdmin, async (_req, res): Promise<void> => {
  const [{ count: userCount }] = await db.select({ count: count() }).from(usersTable);
  const [{ count: messageCount }] = await db.select({ count: count() }).from(messagesTable);
  const [{ count: serverCount }] = await db.select({ count: count() }).from(serversTable);

  // Active users = online or away status
  const allUsers = await db.select({ status: usersTable.status }).from(usersTable);
  const activeUserCount = allUsers.filter(
    (u) => u.status === "online" || u.status === "away"
  ).length;

  res.json({
    userCount: Number(userCount),
    messageCount: Number(messageCount),
    serverCount: Number(serverCount),
    activeUserCount,
  });
});

export default router;
