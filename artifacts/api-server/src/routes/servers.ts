import { Router, type IRouter } from "express";
import { eq, and, count } from "drizzle-orm";
import { db, serversTable, serverMembersTable, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

// GET /servers
router.get("/servers", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;

  const memberships = await db
    .select()
    .from(serverMembersTable)
    .where(eq(serverMembersTable.userId, userId));

  const serverIds = memberships.map((m) => m.serverId);

  if (serverIds.length === 0) {
    res.json([]);
    return;
  }

  const servers = await db
    .select()
    .from(serversTable)
    .where(
      serverIds.length === 1
        ? eq(serversTable.id, serverIds[0])
        : // manual IN using orList
          undefined as any
    );

  // Fallback: get all servers user is member of
  const serversList = await Promise.all(
    serverIds.map(async (id) => {
      const [server] = await db
        .select()
        .from(serversTable)
        .where(eq(serversTable.id, id));
      if (!server) return null;
      const [{ count: memberCount }] = await db
        .select({ count: count() })
        .from(serverMembersTable)
        .where(eq(serverMembersTable.serverId, id));
      return {
        id: server.id,
        name: server.name,
        iconUrl: server.iconUrl,
        ownerId: server.ownerId,
        memberCount: Number(memberCount),
        createdAt: server.createdAt,
      };
    })
  );

  res.json(serversList.filter(Boolean));
});

// POST /servers
router.post("/servers", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const { name } = req.body;

  if (!name) {
    res.status(400).json({ error: "El nombre del servidor es requerido" });
    return;
  }

  const [server] = await db
    .insert(serversTable)
    .values({ name, ownerId: userId })
    .returning();

  // Add owner as member with owner role
  await db.insert(serverMembersTable).values({
    serverId: server.id,
    userId,
    role: "owner",
  });

  res.status(201).json({
    id: server.id,
    name: server.name,
    iconUrl: server.iconUrl,
    ownerId: server.ownerId,
    memberCount: 1,
    createdAt: server.createdAt,
  });
});

// GET /servers/:serverId
router.get("/servers/:serverId", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const serverId = parseInt(raw, 10);

  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) {
    res.status(404).json({ error: "Servidor no encontrado" });
    return;
  }

  const [{ count: memberCount }] = await db
    .select({ count: count() })
    .from(serverMembersTable)
    .where(eq(serverMembersTable.serverId, serverId));

  res.json({
    id: server.id,
    name: server.name,
    iconUrl: server.iconUrl,
    ownerId: server.ownerId,
    memberCount: Number(memberCount),
    createdAt: server.createdAt,
  });
});

// DELETE /servers/:serverId
router.delete("/servers/:serverId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const raw = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const serverId = parseInt(raw, 10);

  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) {
    res.status(404).json({ error: "Servidor no encontrado" });
    return;
  }

  if (server.ownerId !== userId && req.session.userRole !== "admin") {
    res.status(403).json({ error: "No tienes permiso para eliminar este servidor" });
    return;
  }

  await db.delete(serverMembersTable).where(eq(serverMembersTable.serverId, serverId));
  await db.delete(serversTable).where(eq(serversTable.id, serverId));

  res.sendStatus(204);
});

// POST /servers/:serverId/join
router.post("/servers/:serverId/join", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const raw = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const serverId = parseInt(raw, 10);

  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) {
    res.status(404).json({ error: "Servidor no encontrado" });
    return;
  }

  // Check already member
  const [existing] = await db
    .select()
    .from(serverMembersTable)
    .where(
      and(eq(serverMembersTable.serverId, serverId), eq(serverMembersTable.userId, userId))
    );

  if (existing) {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    res.json({
      id: existing.id,
      serverId: existing.serverId,
      userId: existing.userId,
      role: existing.role,
      joinedAt: existing.joinedAt,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        bio: user.bio,
        avatarUrl: user.avatarUrl,
        bannerUrl: user.bannerUrl,
        status: user.status,
        role: user.role,
        createdAt: user.createdAt,
      },
    });
    return;
  }

  const [member] = await db
    .insert(serverMembersTable)
    .values({ serverId, userId, role: "member" })
    .returning();

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));

  res.json({
    id: member.id,
    serverId: member.serverId,
    userId: member.userId,
    role: member.role,
    joinedAt: member.joinedAt,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      bannerUrl: user.bannerUrl,
      status: user.status,
      role: user.role,
      createdAt: user.createdAt,
    },
  });
});

// POST /servers/:serverId/leave
router.post("/servers/:serverId/leave", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const raw = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const serverId = parseInt(raw, 10);

  await db
    .delete(serverMembersTable)
    .where(
      and(eq(serverMembersTable.serverId, serverId), eq(serverMembersTable.userId, userId))
    );

  res.sendStatus(204);
});

// GET /servers/:serverId/members
router.get("/servers/:serverId/members", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
  const serverId = parseInt(raw, 10);

  const members = await db
    .select()
    .from(serverMembersTable)
    .where(eq(serverMembersTable.serverId, serverId));

  const result = await Promise.all(
    members.map(async (member) => {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, member.userId));
      return {
        id: member.id,
        serverId: member.serverId,
        userId: member.userId,
        role: member.role,
        joinedAt: member.joinedAt,
        user: user
          ? {
              id: user.id,
              username: user.username,
              displayName: user.displayName,
              bio: user.bio,
              avatarUrl: user.avatarUrl,
              bannerUrl: user.bannerUrl,
              status: user.status,
              role: user.role,
              createdAt: user.createdAt,
            }
          : null,
      };
    })
  );

  res.json(result);
});

// PATCH /servers/:serverId/members/:userId/role
router.patch(
  "/servers/:serverId/members/:userId/role",
  requireAuth,
  async (req, res): Promise<void> => {
    const currentUserId = req.session.userId!;
    const rawServerId = Array.isArray(req.params.serverId) ? req.params.serverId[0] : req.params.serverId;
    const rawUserId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    const serverId = parseInt(rawServerId, 10);
    const targetUserId = parseInt(rawUserId, 10);
    const { role } = req.body;

    if (!["admin", "member"].includes(role)) {
      res.status(400).json({ error: "Rol inválido" });
      return;
    }

    // Only owner or global admin can change roles
    const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
    if (!server) {
      res.status(404).json({ error: "Servidor no encontrado" });
      return;
    }

    if (server.ownerId !== currentUserId && req.session.userRole !== "admin") {
      res.status(403).json({ error: "No tienes permiso" });
      return;
    }

    const [updatedMember] = await db
      .update(serverMembersTable)
      .set({ role })
      .where(
        and(
          eq(serverMembersTable.serverId, serverId),
          eq(serverMembersTable.userId, targetUserId)
        )
      )
      .returning();

    if (!updatedMember) {
      res.status(404).json({ error: "Miembro no encontrado" });
      return;
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, targetUserId));

    res.json({
      id: updatedMember.id,
      serverId: updatedMember.serverId,
      userId: updatedMember.userId,
      role: updatedMember.role,
      joinedAt: updatedMember.joinedAt,
      user: user
        ? {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            bio: user.bio,
            avatarUrl: user.avatarUrl,
            bannerUrl: user.bannerUrl,
            status: user.status,
            role: user.role,
            createdAt: user.createdAt,
          }
        : null,
    });
  }
);

export default router;
