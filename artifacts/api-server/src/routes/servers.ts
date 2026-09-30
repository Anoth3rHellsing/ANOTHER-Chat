import { Router, type IRouter } from "express";
import { eq, and, count } from "drizzle-orm";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomBytes } from "crypto";
import {
  db,
  serversTable,
  serverMembersTable,
  serverRolesTable,
  serverMemberRolesTable,
  serverInvitesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { getMemberPermissions, PERM, hasPerm } from "../lib/permissions";

const router: IRouter = Router();

// ─── Multer setup for server icon/banner ─────────────────────────────────────
const uploadDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `server-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } });

// ─── Helpers ─────────────────────────────────────────────────────────────────
function parseServerId(raw: string | string[]) {
  return parseInt(Array.isArray(raw) ? raw[0] : raw, 10);
}

/** Fetch the custom roles assigned to a specific member row */
async function getMemberCustomRoles(memberId: number) {
  const rows = await db
    .select({
      id: serverRolesTable.id,
      serverId: serverRolesTable.serverId,
      name: serverRolesTable.name,
      color: serverRolesTable.color,
      permissions: serverRolesTable.permissions,
      position: serverRolesTable.position,
      createdAt: serverRolesTable.createdAt,
    })
    .from(serverMemberRolesTable)
    .innerJoin(serverRolesTable, eq(serverMemberRolesTable.roleId, serverRolesTable.id))
    .where(eq(serverMemberRolesTable.memberId, memberId));
  return rows;
}

async function serializeServer(server: typeof serversTable.$inferSelect) {
  const [{ count: memberCount }] = await db
    .select({ count: count() })
    .from(serverMembersTable)
    .where(eq(serverMembersTable.serverId, server.id));
  return {
    id: server.id,
    name: server.name,
    iconUrl: server.iconUrl,
    bannerUrl: server.bannerUrl,
    isGeneral: server.isGeneral,
    ownerId: server.ownerId,
    memberCount: Number(memberCount),
    createdAt: server.createdAt,
  };
}

async function serializeMember(member: typeof serverMembersTable.$inferSelect, user: typeof usersTable.$inferSelect, roles: any[]) {
  return {
    id: member.id,
    serverId: member.serverId,
    userId: member.userId,
    role: member.role,
    roles,
    joinedAt: member.joinedAt,
    user: {
      id: user.id, username: user.username, displayName: user.displayName,
      bio: user.bio, avatarUrl: user.avatarUrl, bannerUrl: user.bannerUrl,
      status: user.status, role: user.role, createdAt: user.createdAt,
    },
  };
}

function generateInviteCode() {
  return randomBytes(6).toString("base64url"); // 8-char URL-safe code
}

// ─── Routes ──────────────────────────────────────────────────────────────────

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

  const serversList = await Promise.all(
    serverIds.map(async (id) => {
      const [server] = await db.select().from(serversTable).where(eq(serversTable.id, id));
      if (!server) return null;
      return serializeServer(server);
    })
  );

  // Sort: general server first, then by id
  const sorted = serversList
    .filter(Boolean)
    .sort((a: any, b: any) => {
      if (a.isGeneral && !b.isGeneral) return -1;
      if (!a.isGeneral && b.isGeneral) return 1;
      return a.id - b.id;
    });

  res.json(sorted);
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

  await db.insert(serverMembersTable).values({
    serverId: server.id,
    userId,
    role: "owner",
  });

  res.status(201).json(await serializeServer(server));
});

// POST /servers/join-by-invite  ← must come BEFORE /servers/:serverId
router.post("/servers/join-by-invite", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const { code } = req.body;

  if (!code) {
    res.status(400).json({ error: "Se requiere un código de invitación" });
    return;
  }

  const [invite] = await db
    .select()
    .from(serverInvitesTable)
    .where(eq(serverInvitesTable.code, code.trim()));

  if (!invite || invite.revoked) {
    res.status(404).json({ error: "Código de invitación inválido o revocado" });
    return;
  }

  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    res.status(400).json({ error: "El código de invitación ha expirado" });
    return;
  }

  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, invite.serverId));
  if (!server) {
    res.status(404).json({ error: "Servidor no encontrado" });
    return;
  }

  // Already a member?
  const [existing] = await db
    .select()
    .from(serverMembersTable)
    .where(and(eq(serverMembersTable.serverId, server.id), eq(serverMembersTable.userId, userId)));

  if (!existing) {
    await db.insert(serverMembersTable).values({ serverId: server.id, userId, role: "member" });
    // Mark invite as used
    await db.update(serverInvitesTable)
      .set({ usedById: userId })
      .where(eq(serverInvitesTable.id, invite.id));
  }

  res.json(await serializeServer(server));
});

// GET /servers/:serverId
router.get("/servers/:serverId", requireAuth, async (req, res): Promise<void> => {
  const serverId = parseServerId(req.params.serverId);
  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) { res.status(404).json({ error: "Servidor no encontrado" }); return; }
  res.json(await serializeServer(server));
});

// DELETE /servers/:serverId
router.delete("/servers/:serverId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const serverId = parseServerId(req.params.serverId);

  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) { res.status(404).json({ error: "Servidor no encontrado" }); return; }
  if (server.isGeneral) { res.status(403).json({ error: "El servidor general no puede ser eliminado" }); return; }

  if (server.ownerId !== userId && req.session.userRole !== "admin") {
    res.status(403).json({ error: "No tienes permiso para eliminar este servidor" });
    return;
  }

  await db.delete(serverMembersTable).where(eq(serverMembersTable.serverId, serverId));
  await db.delete(serverRolesTable).where(eq(serverRolesTable.serverId, serverId));
  await db.delete(serverInvitesTable).where(eq(serverInvitesTable.serverId, serverId));
  await db.delete(serversTable).where(eq(serversTable.id, serverId));

  res.sendStatus(204);
});

// No existe POST /servers/:serverId/join: la única forma de entrar a un
// servidor es una invitación válida (POST /servers/join-by-invite). El
// servidor General añade a cada usuario al registrarse (lib/general-server.ts).

// POST /servers/:serverId/leave
router.post("/servers/:serverId/leave", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const serverId = parseServerId(req.params.serverId);

  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
  if (server?.isGeneral) {
    res.status(403).json({ error: "No puedes abandonar el servidor general" });
    return;
  }

  await db
    .delete(serverMembersTable)
    .where(and(eq(serverMembersTable.serverId, serverId), eq(serverMembersTable.userId, userId)));

  res.sendStatus(204);
});

// GET /servers/:serverId/members
router.get("/servers/:serverId/members", requireAuth, async (req, res): Promise<void> => {
  const serverId = parseServerId(req.params.serverId);

  const members = await db
    .select()
    .from(serverMembersTable)
    .where(eq(serverMembersTable.serverId, serverId));

  const result = await Promise.all(
    members.map(async (member) => {
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, member.userId));
      const roles = await getMemberCustomRoles(member.id);
      return user ? serializeMember(member, user, roles) : null;
    })
  );

  res.json(result.filter(Boolean));
});

// PATCH /servers/:serverId/members/:userId/role
router.patch(
  "/servers/:serverId/members/:userId/role",
  requireAuth,
  async (req, res): Promise<void> => {
    const currentUserId = req.session.userId!;
    const serverId = parseServerId(req.params.serverId);
    const targetUserId = parseServerId(req.params.userId);
    const { role } = req.body;

    if (!["admin", "member"].includes(role)) {
      res.status(400).json({ error: "Rol inválido" });
      return;
    }

    const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
    if (!server) { res.status(404).json({ error: "Servidor no encontrado" }); return; }

    if (server.ownerId !== currentUserId && req.session.userRole !== "admin") {
      res.status(403).json({ error: "No tienes permiso" });
      return;
    }

    const [updatedMember] = await db
      .update(serverMembersTable)
      .set({ role })
      .where(and(eq(serverMembersTable.serverId, serverId), eq(serverMembersTable.userId, targetUserId)))
      .returning();

    if (!updatedMember) { res.status(404).json({ error: "Miembro no encontrado" }); return; }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, targetUserId));
    const roles = await getMemberCustomRoles(updatedMember.id);

    res.json(await serializeMember(updatedMember, user, roles));
  }
);

// ─── Server invite routes ─────────────────────────────────────────────────────

// GET /servers/:serverId/invites
router.get("/servers/:serverId/invites", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const serverId = parseServerId(req.params.serverId);

  const perms = await getMemberPermissions(serverId, userId);
  const isAllowed = req.session.userRole === "admin" || perms === 0xffffffff || hasPerm(perms, PERM.MANAGE_CHANNELS);
  if (!isAllowed) { res.status(403).json({ error: "No tienes permiso" }); return; }

  const invites = await db
    .select()
    .from(serverInvitesTable)
    .where(and(eq(serverInvitesTable.serverId, serverId), eq(serverInvitesTable.revoked, false)));

  res.json(invites);
});

// POST /servers/:serverId/invites
router.post("/servers/:serverId/invites", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const serverId = parseServerId(req.params.serverId);

  const perms = await getMemberPermissions(serverId, userId);
  const isAllowed = req.session.userRole === "admin" || perms === 0xffffffff || hasPerm(perms, PERM.MANAGE_CHANNELS);
  if (!isAllowed) { res.status(403).json({ error: "No tienes permiso para crear invitaciones" }); return; }

  const code = generateInviteCode();
  const [invite] = await db
    .insert(serverInvitesTable)
    .values({ serverId, code, createdById: userId })
    .returning();

  res.status(201).json(invite);
});

// DELETE /servers/:serverId/invites/:code
router.delete("/servers/:serverId/invites/:code", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const serverId = parseServerId(req.params.serverId);
  const code = Array.isArray(req.params.code) ? req.params.code[0] : req.params.code;

  const perms = await getMemberPermissions(serverId, userId);
  const isAllowed = req.session.userRole === "admin" || perms === 0xffffffff || hasPerm(perms, PERM.MANAGE_CHANNELS);
  if (!isAllowed) { res.status(403).json({ error: "No tienes permiso" }); return; }

  await db
    .update(serverInvitesTable)
    .set({ revoked: true })
    .where(and(eq(serverInvitesTable.serverId, serverId), eq(serverInvitesTable.code, code)));

  res.sendStatus(204);
});

// ─── Server icon / banner upload ──────────────────────────────────────────────

function canManageServerCheck(server: typeof serversTable.$inferSelect, userId: number, userRole: string) {
  return server.ownerId === userId || userRole === "admin";
}

// POST /servers/:serverId/icon
router.post("/servers/:serverId/icon", requireAuth, upload.single("file"), async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const serverId = parseServerId(req.params.serverId);

  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) { res.status(404).json({ error: "Servidor no encontrado" }); return; }
  if (!canManageServerCheck(server, userId, req.session.userRole!)) {
    res.status(403).json({ error: "No tienes permiso" }); return;
  }

  if (!req.file) { res.status(400).json({ error: "No se recibió ningún archivo" }); return; }

  const baseUrl = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "";
  const url = `${baseUrl}/api/uploads/${req.file.filename}`;

  await db.update(serversTable).set({ iconUrl: url }).where(eq(serversTable.id, serverId));
  res.json({ url });
});

// POST /servers/:serverId/banner
router.post("/servers/:serverId/banner", requireAuth, upload.single("file"), async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const serverId = parseServerId(req.params.serverId);

  const [server] = await db.select().from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) { res.status(404).json({ error: "Servidor no encontrado" }); return; }
  if (!canManageServerCheck(server, userId, req.session.userRole!)) {
    res.status(403).json({ error: "No tienes permiso" }); return;
  }

  if (!req.file) { res.status(400).json({ error: "No se recibió ningún archivo" }); return; }

  const baseUrl = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "";
  const url = `${baseUrl}/api/uploads/${req.file.filename}`;

  await db.update(serversTable).set({ bannerUrl: url }).where(eq(serversTable.id, serverId));
  res.json({ url });
});

export default router;
