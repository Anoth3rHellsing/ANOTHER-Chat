import { Router, type IRouter } from "express";
import bcrypt from "bcrypt";
import { eq, isNull, count } from "drizzle-orm";
import { db, usersTable, inviteCodesTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router: IRouter = Router();

// POST /auth/login
router.post("/auth/login", async (req, res): Promise<void> => {
  const { username, password } = req.body;
  if (!username || !password) {
    res.status(400).json({ error: "Faltan campos requeridos" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username.toLowerCase()));

  if (!user) {
    res.status(401).json({ error: "Credenciales inválidas" });
    return;
  }

  if (user.banned) {
    res.status(403).json({ error: "Tu cuenta ha sido baneada" });
    return;
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    res.status(401).json({ error: "Credenciales inválidas" });
    return;
  }

  // Update status to online
  await db
    .update(usersTable)
    .set({ status: "online" })
    .where(eq(usersTable.id, user.id));

  req.session.userId = user.id;
  req.session.userRole = user.role;

  // Explicitly save the session before responding so the PostgreSQL store's
  // async set() completes and the Set-Cookie header is sent with the response.
  req.session.save((err) => {
    if (err) {
      res.status(500).json({ error: "Error al guardar la sesión" });
      return;
    }
    res.json({
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      bio: user.bio,
      avatarUrl: user.avatarUrl,
      bannerUrl: user.bannerUrl,
      status: "online",
      role: user.role,
      createdAt: user.createdAt,
    });
  });
});

// POST /auth/register
router.post("/auth/register", async (req, res): Promise<void> => {
  const { username, password, displayName, inviteCode } = req.body;

  if (!username || !password || !displayName) {
    res.status(400).json({ error: "Faltan campos requeridos" });
    return;
  }

  if (username.length < 3 || username.length > 32) {
    res.status(400).json({ error: "El nombre de usuario debe tener entre 3 y 32 caracteres" });
    return;
  }

  if (password.length < 8) {
    res.status(400).json({ error: "La contraseña debe tener al menos 8 caracteres" });
    return;
  }

  // Check if this is the very first user
  const [{ count: userCount }] = await db.select({ count: count() }).from(usersTable);

  const isFirstUser = Number(userCount) === 0;

  if (!isFirstUser) {
    // Require invite code
    if (!inviteCode) {
      res.status(400).json({ error: "Se requiere un código de invitación" });
      return;
    }

    const [invite] = await db
      .select()
      .from(inviteCodesTable)
      .where(eq(inviteCodesTable.code, inviteCode));

    if (!invite || invite.revoked || invite.usedById !== null) {
      res.status(400).json({ error: "Código de invitación inválido o ya usado" });
      return;
    }
  }

  // Check username taken
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username.toLowerCase()));

  if (existing) {
    res.status(400).json({ error: "El nombre de usuario ya está en uso" });
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const [newUser] = await db
    .insert(usersTable)
    .values({
      username: username.toLowerCase(),
      passwordHash,
      displayName,
      role: isFirstUser ? "admin" : "member",
      status: "online",
    })
    .returning();

  // Mark invite as used
  if (!isFirstUser && inviteCode) {
    await db
      .update(inviteCodesTable)
      .set({ usedById: newUser.id, usedAt: new Date() })
      .where(eq(inviteCodesTable.code, inviteCode));
  }

  req.session.userId = newUser.id;
  req.session.userRole = newUser.role;

  req.session.save((err) => {
    if (err) {
      res.status(500).json({ error: "Error al guardar la sesión" });
      return;
    }
    res.status(201).json({
      id: newUser.id,
      username: newUser.username,
      displayName: newUser.displayName,
      bio: newUser.bio,
      avatarUrl: newUser.avatarUrl,
      bannerUrl: newUser.bannerUrl,
      status: "online",
      role: newUser.role,
      createdAt: newUser.createdAt,
    });
  });
});

// POST /auth/logout
router.post("/auth/logout", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId;
  if (userId) {
    await db
      .update(usersTable)
      .set({ status: "offline" })
      .where(eq(usersTable.id, userId));
  }

  req.session.destroy((err) => {
    if (err) {
      req.log.error({ err }, "Error destroying session");
    }
  });
  res.sendStatus(204);
});

// GET /auth/me
router.get("/auth/me", requireAuth, async (req, res): Promise<void> => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!));

  if (!user) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }

  res.json({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    bannerUrl: user.bannerUrl,
    status: user.status,
    role: user.role,
    createdAt: user.createdAt,
  });
});

export default router;
