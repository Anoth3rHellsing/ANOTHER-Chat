import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import multer from "multer";
import { z } from "zod/v4";
import { db, usersTable } from "@workspace/db";
import { requireAuth } from "../lib/auth";

// Cadena vacía o solo espacios = sin valor: se guarda null, como hacía la versión anterior.
const optionalTrimmedText = (max: number, message: string) =>
  z.string({ error: "Debe ser un texto." })
    .max(max, message)
    .nullable()
    .optional()
    .transform(value => (typeof value === "string" ? (value.trim() || null) : value));

const patchUserSchema = z.object({
  displayName: z.string({ error: "El nombre visible debe ser un texto." })
    .min(1, "El nombre visible no puede estar vacío.")
    .max(64, "El nombre visible admite como máximo 64 caracteres.")
    .optional(),
  bio: z.string({ error: "La biografía debe ser un texto." })
    .max(500, "La biografía admite como máximo 500 caracteres.")
    .optional(),
  status: z.enum(["online", "away", "dnd", "offline"], {
    error: "Estado no válido. Usa online, away, dnd u offline.",
  }).optional(),
  socialLinks: z.array(z.object({
    platform: z.string({ error: "Cada enlace necesita una plataforma." }),
    url: z.string({ error: "Cada enlace necesita una dirección." }),
    label: z.string().optional(),
  }), { error: "Los enlaces sociales deben ser una lista." }).optional(),
  customStatus: optionalTrimmedText(128, "El estado personalizado admite como máximo 128 caracteres."),
  statusEmoji: optionalTrimmedText(20, "El emoji de estado admite como máximo 20 caracteres."),
  // Cambio hecho por la detección automática (inactividad o llamada), no por el usuario.
  auto: z.literal(true, { error: "auto solo admite true." }).optional(),
}, { error: "El cuerpo de la petición debe ser un objeto." });

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

// Solo para respuestas sobre el propio usuario: `invisible` nunca se expone a otros.
function serializeOwnUser(user: typeof usersTable.$inferSelect) {
  return { ...serializeUser(user), invisible: user.invisible };
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
    const message = issue?.message ?? "Datos inválidos.";
    res.status(400).json({ error: message });
    return;
  }

  const { displayName, bio, status, socialLinks, customStatus, statusEmoji, auto } = parsed.data;

  if (auto) {
    await applyAutomaticStatus(userId, status, parsed.data, res);
    return;
  }

  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (displayName !== undefined) updates.displayName = displayName;
  if (bio !== undefined) updates.bio = bio;
  if (status !== undefined) {
    updates.status = status;
    // Elegir "Desconectado" a mano activa el modo invisible; cualquier otro estado lo desactiva.
    updates.invisible = status === "offline";
  }
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

  res.json(serializeOwnUser(updated));
});

// Un cambio automático solo toca `status` y nunca a un usuario invisible.
async function applyAutomaticStatus(
  userId: number,
  status: "online" | "away" | "dnd" | "offline" | undefined,
  body: Record<string, unknown>,
  res: import("express").Response,
): Promise<void> {
  const otherFields = Object.keys(body).filter(key => key !== "auto" && key !== "status" && body[key] !== undefined);
  if (status === undefined || status === "offline" || otherFields.length > 0) {
    res.status(400).json({ error: "Un cambio automático solo puede fijar online, away o dnd." });
    return;
  }
  const [updated] = await db
    .update(usersTable)
    .set({ status })
    .where(and(eq(usersTable.id, userId), eq(usersTable.invisible, false)))
    .returning();
  if (!updated) {
    // Modo invisible: se ignora sin error y se devuelve el estado real.
    const [current] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
    res.json(serializeOwnUser(current));
    return;
  }
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
  res.json(serializeOwnUser(updated));
}

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
