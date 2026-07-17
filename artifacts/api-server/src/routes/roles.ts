import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import {
  db,
  serverRolesTable,
  serverMembersTable,
  serverMemberRolesTable,
  serversTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { getMembership } from "../lib/permissions";

const router: IRouter = Router();

/** Helper: check if current user can manage this server (owner, server-admin, or global admin) */
async function canManageServer(
  serverId: number,
  userId: number,
  globalRole: string | undefined
): Promise<boolean> {
  if (globalRole === "admin") return true;
  const membership = await getMembership(serverId, userId);
  if (!membership) return false;
  return membership.role === "owner" || membership.role === "admin";
}

// ─── Role CRUD ───────────────────────────────────────────────────────────────

// GET /servers/:serverId/roles
router.get("/servers/:serverId/roles", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const rawSid = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const serverId = parseInt(rawSid, 10);

  // Require server membership to view roles (or global admin)
  if (req.session.userRole !== "admin") {
    const membership = await getMembership(serverId, userId);
    if (!membership) {
      res.status(403).json({ error: "No eres miembro de este servidor" });
      return;
    }
  }

  const roles = await db
    .select()
    .from(serverRolesTable)
    .where(eq(serverRolesTable.serverId, serverId));

  res.json(
    roles.map((r) => ({
      id: r.id,
      serverId: r.serverId,
      name: r.name,
      color: r.color,
      permissions: r.permissions,
      position: r.position,
      createdAt: r.createdAt,
    }))
  );
});

// POST /servers/:serverId/roles
router.post("/servers/:serverId/roles", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const rawSid = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const serverId = parseInt(rawSid, 10);
  const { name, color = "#6366f1", permissions = 0 } = req.body;

  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "Se requiere un nombre para el rol" });
    return;
  }

  if (!(await canManageServer(serverId, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes permiso para gestionar roles" });
    return;
  }

  // Position = current max + 1
  const existingRoles = await db
    .select({ position: serverRolesTable.position })
    .from(serverRolesTable)
    .where(eq(serverRolesTable.serverId, serverId));
  const position = existingRoles.length > 0
    ? Math.max(...existingRoles.map((r) => r.position)) + 1
    : 0;

  const [role] = await db
    .insert(serverRolesTable)
    .values({ serverId, name: name.trim(), color, permissions: Number(permissions), position })
    .returning();

  res.status(201).json({
    id: role.id,
    serverId: role.serverId,
    name: role.name,
    color: role.color,
    permissions: role.permissions,
    position: role.position,
    createdAt: role.createdAt,
  });
});

// PATCH /servers/:serverId/roles/:roleId
router.patch("/servers/:serverId/roles/:roleId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const rawSid = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const rawRid = Array.isArray(req.params.roleId) ? req.params.roleId[0] : req.params.roleId;
  const serverId = parseInt(rawSid, 10);
  const roleId = parseInt(rawRid, 10);
  const { name, color, permissions } = req.body;

  if (!(await canManageServer(serverId, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes permiso para gestionar roles" });
    return;
  }

  const updates: Record<string, any> = {};
  if (name !== undefined) updates.name = String(name).trim();
  if (color !== undefined) updates.color = String(color);
  if (permissions !== undefined) updates.permissions = Number(permissions);

  const [updated] = await db
    .update(serverRolesTable)
    .set(updates)
    .where(and(eq(serverRolesTable.id, roleId), eq(serverRolesTable.serverId, serverId)))
    .returning();

  if (!updated) {
    res.status(404).json({ error: "Rol no encontrado" });
    return;
  }

  res.json({
    id: updated.id,
    serverId: updated.serverId,
    name: updated.name,
    color: updated.color,
    permissions: updated.permissions,
    position: updated.position,
    createdAt: updated.createdAt,
  });
});

// DELETE /servers/:serverId/roles/:roleId
router.delete("/servers/:serverId/roles/:roleId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const rawSid = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const rawRid = Array.isArray(req.params.roleId) ? req.params.roleId[0] : req.params.roleId;
  const serverId = parseInt(rawSid, 10);
  const roleId = parseInt(rawRid, 10);

  if (!(await canManageServer(serverId, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes permiso para gestionar roles" });
    return;
  }

  // Remove all member assignments first
  await db
    .delete(serverMemberRolesTable)
    .where(eq(serverMemberRolesTable.roleId, roleId));

  await db
    .delete(serverRolesTable)
    .where(and(eq(serverRolesTable.id, roleId), eq(serverRolesTable.serverId, serverId)));

  res.sendStatus(204);
});

// ─── Member role assignment ───────────────────────────────────────────────────

// POST /servers/:serverId/members/:userId/roles/:roleId — assign role
router.post(
  "/servers/:serverId/members/:userId/roles/:roleId",
  requireAuth,
  async (req, res): Promise<void> => {
    const callerId = req.session.userId!;
    const rawSid = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
    const rawUid = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const rawRid = Array.isArray(req.params.roleId) ? req.params.roleId[0] : req.params.roleId;
    const serverId = parseInt(rawSid, 10);
    const targetUserId = parseInt(rawUid, 10);
    const roleId = parseInt(rawRid, 10);

    if (!(await canManageServer(serverId, callerId, req.session.userRole))) {
      res.status(403).json({ error: "No tienes permiso para asignar roles" });
      return;
    }

    // Find target member row
    const [targetMember] = await db
      .select()
      .from(serverMembersTable)
      .where(
        and(
          eq(serverMembersTable.serverId, serverId),
          eq(serverMembersTable.userId, targetUserId)
        )
      );

    if (!targetMember) {
      res.status(404).json({ error: "Miembro no encontrado" });
      return;
    }

    // Verify role belongs to this server
    const [role] = await db
      .select()
      .from(serverRolesTable)
      .where(and(eq(serverRolesTable.id, roleId), eq(serverRolesTable.serverId, serverId)));

    if (!role) {
      res.status(404).json({ error: "Rol no encontrado" });
      return;
    }

    // Idempotent: skip if already assigned
    const [existing] = await db
      .select()
      .from(serverMemberRolesTable)
      .where(
        and(
          eq(serverMemberRolesTable.memberId, targetMember.id),
          eq(serverMemberRolesTable.roleId, roleId)
        )
      );

    if (!existing) {
      await db
        .insert(serverMemberRolesTable)
        .values({ memberId: targetMember.id, roleId });
    }

    res.sendStatus(200);
  }
);

// DELETE /servers/:serverId/members/:userId/roles/:roleId — remove role
router.delete(
  "/servers/:serverId/members/:userId/roles/:roleId",
  requireAuth,
  async (req, res): Promise<void> => {
    const callerId = req.session.userId!;
    const rawSid = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
    const rawUid = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const rawRid = Array.isArray(req.params.roleId) ? req.params.roleId[0] : req.params.roleId;
    const serverId = parseInt(rawSid, 10);
    const targetUserId = parseInt(rawUid, 10);
    const roleId = parseInt(rawRid, 10);

    if (!(await canManageServer(serverId, callerId, req.session.userRole))) {
      res.status(403).json({ error: "No tienes permiso para gestionar roles" });
      return;
    }

    const [targetMember] = await db
      .select()
      .from(serverMembersTable)
      .where(
        and(
          eq(serverMembersTable.serverId, serverId),
          eq(serverMembersTable.userId, targetUserId)
        )
      );

    if (!targetMember) {
      res.status(404).json({ error: "Miembro no encontrado" });
      return;
    }

    await db
      .delete(serverMemberRolesTable)
      .where(
        and(
          eq(serverMemberRolesTable.memberId, targetMember.id),
          eq(serverMemberRolesTable.roleId, roleId)
        )
      );

    res.sendStatus(204);
  }
);

export default router;
