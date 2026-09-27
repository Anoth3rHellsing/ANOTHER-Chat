import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import multer from "multer";
import { z } from "zod/v4";
import { db, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";

const patchUserSchema = z.object({
  displayName: z.string().min(1).max(64).optional(),
  bio: z.string().max(500).optional(),
  status: z.enum(["online", "away", "dnd", "offline"]).optional(),
  socialLinks: z.array(z.object({
    platform: z.string(),
    url: z.string(),
    label: z.string().optional(),
  })).optional(),
  customStatus: z.string().max(128).nullable().optional(),
  statusEmoji: z.string().max(20).nullable().optional(),
});

const router: IRouter = Router();

const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename(_req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    const name = `${Date.now()}-${Math.random().toString(36).substring(2)}${ext}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter(_req, file, cb) {
    const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  },
});

/** Parse the socialLinks JSON stored as text */
function parseSocialLinks(raw: string): Array<{ platform: string; url: string; label?: string }> {
  try {
    return JSON.parse(raw) as Array<{ platform: string; url: string; label?: string }>;
  } catch {
    return [];
  }
}

/** Serialize a user row to the public profile shape */
function serializeUser(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    bio: user.bio,
    avatarUrl: user.avatarUrl,
    bannerUrl: user.bannerUrl,
    status: user.status,
    role: user.role,
    createdAt: user.createdAt,
    socialLinks: parseSocialLinks(user.socialLinks),
    customStatus: user.customStatus ?? null,
    statusEmoji: user.statusEmoji ?? null,
  };
}

// GET /users/:userId
router.get("/users/:userId", requireAuth, async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
  const userId = parseInt(raw, 10);

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user) {
    res.status(404).json({ error: "Usuario no encontrado" });
    return;
  }

  res.json(serializeUser(user));
});

// PATCH /users/me
router.patch("/users/me", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;

  const parsed = patchUserSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue?.message ?? "Datos inválidos";
    res.status(400).json({ error: message });
    return;
  }

  const { displayName, bio, status, socialLinks, customStatus, statusEmoji } = parsed.data;

  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (displayName !== undefined) updates.displayName = displayName;
  if (bio !== undefined) updates.bio = bio;
  if (status !== undefined) updates.status = status;
  if (socialLinks !== undefined) updates.socialLinks = JSON.stringify(socialLinks);
  if (customStatus !== undefined) updates.customStatus = customStatus;
  if (statusEmoji !== undefined) updates.statusEmoji = statusEmoji;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No hay cambios para aplicar" });
    return;
  }

  const [updated] = await db
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, userId))
    .returning();

  // Broadcast status change via WebSocket
  if (status !== undefined || customStatus !== undefined || statusEmoji !== undefined) {
    const { broadcastAll } = await import("../lib/websocket");
    broadcastAll({
      type: "user:status",
      data: {
        userId,
        status: updated.status,
        customStatus: updated.customStatus ?? null,
        statusEmoji: updated.statusEmoji ?? null,
      },
    });
  }

  res.json(serializeUser(updated));
});

// POST /users/me/avatar
router.post(
  "/users/me/avatar",
  requireAuth,
  upload.single("file"),
  async (req, res): Promise<void> => {
    const userId = req.session.userId!;

    if (!req.file) {
      res.status(400).json({ error: "No se recibió ningún archivo" });
      return;
    }

    const url = `/api/uploads/${req.file.filename}`;
    await db.update(usersTable).set({ avatarUrl: url }).where(eq(usersTable.id, userId));

    res.json({ url });
  }
);

// POST /users/me/banner
router.post(
  "/users/me/banner",
  requireAuth,
  upload.single("file"),
  async (req, res): Promise<void> => {
    const userId = req.session.userId!;

    if (!req.file) {
      res.status(400).json({ error: "No se recibió ningún archivo" });
      return;
    }

    const url = `/api/uploads/${req.file.filename}`;
    await db.update(usersTable).set({ bannerUrl: url }).where(eq(usersTable.id, userId));

    res.json({ url });
  }
);

export default router;
