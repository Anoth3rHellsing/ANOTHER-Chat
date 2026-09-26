import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";
import { parseFile } from "music-metadata";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import {
  db,
  channelsTable,
  serversTable,
  serverMembersTable,
  soundboardClipsTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { canAccessChannel, getMemberPermissions, getMembership, hasPerm, PERM } from "../lib/permissions";
import { emitSoundboardToCall } from "../lib/websocket";
import { soundboardTriggerRateLimit } from "../middleware/rate-limit";

const router: IRouter = Router();
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const MAX_FILE_BYTES = 256 * 1024;
const MAX_CLIPS_PER_SERVER = 100;
const MAX_DURATION_MS = 5_000;
const TRIGGER_COOLDOWN_MS = 2_000;
const triggerTimes = new Map<number, number>();

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, _file, cb) => cb(null, `soundboard-${randomUUID()}.upload`),
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 5 },
});

function parsePositiveId(value: unknown): number | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function serializeClip(clip: typeof soundboardClipsTable.$inferSelect) {
  return {
    id: clip.id,
    serverId: clip.serverId,
    name: clip.name,
    durationMs: clip.durationMs,
    sizeBytes: clip.sizeBytes,
    mimeType: clip.mimeType,
    url: `/api/soundboard/clips/${clip.id}/audio`,
    uploadedBy: clip.uploadedBy,
    createdAt: clip.createdAt,
  };
}

function getClipDiskPath(clip: typeof soundboardClipsTable.$inferSelect): string | null {
  const extensionByMime: Record<string, string> = {
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/webm": ".webm",
  };
  const extension = extensionByMime[clip.mimeType];
  const prefix = "/api/uploads/";
  if (!extension || !clip.url.startsWith(prefix)) return null;
  const filename = clip.url.slice(prefix.length);
  if (!new RegExp(`^soundboard-[0-9a-f-]+\\${extension}$`, "i").test(filename)) return null;
  const root = path.resolve(UPLOADS_DIR);
  const filePath = path.resolve(root, filename);
  if (path.dirname(filePath) !== root) return null;
  return filePath;
}

function canManageSoundboard(globalRole: string | undefined, permissions: number): boolean {
  return globalRole === "admin" || permissions === 0xffffffff || hasPerm(permissions, PERM.MANAGE_CHANNELS);
}

async function canManageServer(userId: number, globalRole: string | undefined, serverId: number) {
  const permissions = await getMemberPermissions(serverId, userId);
  return canManageSoundboard(globalRole, permissions);
}

async function getSniffedAudio(filePath: string): Promise<{ mimeType: string; extension: string; durationMs: number }> {
  const handle = await fs.promises.open(filePath, "r");
  const header = Buffer.alloc(16);
  try {
    await handle.read(header, 0, header.length, 0);
  } finally {
    await handle.close();
  }

  let mimeType: string | null = null;
  let extension: string | null = null;
  if (header.subarray(0, 3).toString("ascii") === "ID3" ||
      (header[0] === 0xff && (header[1] & 0xe0) === 0xe0)) {
    mimeType = "audio/mpeg";
    extension = ".mp3";
  } else if (header.subarray(0, 4).toString("ascii") === "RIFF" &&
             header.subarray(8, 12).toString("ascii") === "WAVE") {
    mimeType = "audio/wav";
    extension = ".wav";
  } else if (header.subarray(0, 4).toString("ascii") === "OggS") {
    mimeType = "audio/ogg";
    extension = ".ogg";
  } else if (header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    mimeType = "audio/webm";
    extension = ".webm";
  }
  if (!mimeType || !extension) throw new Error("El formato de audio no es compatible o su cabecera no es válida.");
  // music-metadata does not expose all video tracks in WebM. Reject the container
  // rather than risk accepting a mixed audio/video upload.
  if (mimeType === "audio/webm") throw new Error("El formato WebM no está permitido en el soundboard.");

  let metadata: Awaited<ReturnType<typeof parseFile>>;
  try {
    metadata = await parseFile(filePath, { duration: true, skipCovers: true });
  } catch {
    throw new Error("No se pudo verificar el formato ni la duración del audio.");
  }

  const expectedContainer: Record<string, string> = {
    "audio/mpeg": "MPEG",
    "audio/wav": "WAVE",
    "audio/ogg": "Ogg",
  };
  if (metadata.format.container !== expectedContainer[mimeType]) {
    throw new Error("El contenedor real del audio no coincide con su cabecera.");
  }
  if (!metadata.format.codec || !metadata.format.numberOfChannels) {
    throw new Error("El archivo no contiene una pista de audio válida.");
  }
  if (mimeType === "audio/mpeg" && !/Layer 3|MP3/i.test(metadata.format.codec)) {
    throw new Error("El archivo no contiene una pista MP3 válida.");
  }
  const duration = metadata.format.duration;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    throw new Error("No se pudo determinar la duración del audio.");
  }
  const durationMs = Math.ceil(duration * 1000);
  if (durationMs > MAX_DURATION_MS) throw new Error("El clip de audio no puede durar más de 5 segundos.");
  return { mimeType, extension, durationMs };
}

// Require server membership before accepting an upload to disk.
async function requireUploadPermission(req: Request, res: Response, next: NextFunction): Promise<void> {
  const serverId = parsePositiveId(req.params.serverId);
  if (!serverId) { res.status(400).json({ error: "ID de servidor no válido." }); return; }
  const [server] = await db.select({ id: serversTable.id }).from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) { res.status(404).json({ error: "Servidor no encontrado." }); return; }
  if (req.session.userRole === "admin") { next(); return; }
  const membership = await getMembership(serverId, req.session.userId!);
  if (!membership) {
    res.status(403).json({ error: "Debes ser miembro del servidor para subir clips al soundboard." });
    return;
  }
  next();
}

function receiveClipUpload(req: Request, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (error: unknown) => {
    if (!error) { next(); return; }
    const isTooLarge = typeof error === "object" && error !== null && "code" in error &&
      (error as { code?: string }).code === "LIMIT_FILE_SIZE";
    res.status(isTooLarge ? 413 : 400).json({
      error: isTooLarge ? "El audio del soundboard no puede superar 256 KiB." : "La subida del clip no es válida.",
    });
  });
}

function unlinkQuietly(filePath: string | undefined) {
  if (filePath) fs.unlink(filePath, () => {});
}

// GET /soundboard/clips/:clipId/audio
router.get("/soundboard/clips/:clipId/audio", requireAuth, async (req, res, next): Promise<void> => {
  const clipId = parsePositiveId(req.params.clipId);
  if (!clipId) { res.status(404).json({ error: "Clip del soundboard no encontrado." }); return; }
  const [clip] = await db.select().from(soundboardClipsTable)
    .where(eq(soundboardClipsTable.id, clipId));
  if (!clip) { res.status(404).json({ error: "Clip del soundboard no encontrado." }); return; }

  if (req.session.userRole !== "admin" && !(await getMembership(clip.serverId, req.session.userId!))) {
    res.status(403).json({ error: "No perteneces a este servidor." }); return;
  }
  const filePath = getClipDiskPath(clip);
  if (!filePath) { res.status(404).json({ error: "Archivo de audio del soundboard no encontrado." }); return; }
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile()) { res.status(404).json({ error: "Archivo de audio del soundboard no encontrado." }); return; }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      res.status(404).json({ error: "Archivo de audio del soundboard no encontrado." }); return;
    }
    next(error);
    return;
  }

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("Content-Disposition", "attachment");
  // Server-scoped audio is replayed often; keep it only in the member's browser
  // for one minute. Every stale/conditional request still checks membership.
  res.setHeader("Cache-Control", "private, max-age=60, must-revalidate");
  res.vary("Cookie");
  res.setHeader("Content-Type", clip.mimeType);
  res.sendFile(filePath, { cacheControl: false }, (error) => {
    if (!error) return;
    if (res.headersSent) { res.destroy(error); return; }
    next(error);
  });
});

// GET /servers/:serverId/soundboard
router.get("/servers/:serverId/soundboard", requireAuth, async (req, res): Promise<void> => {
  const serverId = parsePositiveId(req.params.serverId);
  if (!serverId) { res.status(400).json({ error: "ID de servidor no válido." }); return; }
  const [server] = await db.select({ id: serversTable.id }).from(serversTable).where(eq(serversTable.id, serverId));
  if (!server) { res.status(404).json({ error: "Servidor no encontrado." }); return; }
  if (!(await getMembership(serverId, req.session.userId!)) && req.session.userRole !== "admin") {
    res.status(403).json({ error: "No perteneces a este servidor." }); return;
  }
  const clips = await db.select().from(soundboardClipsTable)
    .where(eq(soundboardClipsTable.serverId, serverId))
    .orderBy(soundboardClipsTable.createdAt);
  res.json(clips.map(serializeClip));
});

// POST /servers/:serverId/soundboard (multipart fields: file, name)
router.post(
  "/servers/:serverId/soundboard",
  requireAuth,
  requireUploadPermission,
  receiveClipUpload,
  async (req, res): Promise<void> => {
    const serverId = parsePositiveId(req.params.serverId)!;
    const file = req.file;
    if (!file) { res.status(400).json({ error: "Se requiere un archivo de audio." }); return; }
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 80) {
      unlinkQuietly(file.path);
      res.status(400).json({ error: "El nombre del clip debe tener entre 1 y 80 caracteres." }); return;
    }

    let detected: Awaited<ReturnType<typeof getSniffedAudio>>;
    let finalPath: string;
    try {
      detected = await getSniffedAudio(file.path);
      finalPath = `${file.path.slice(0, -".upload".length)}${detected.extension}`;
      await fs.promises.rename(file.path, finalPath);
    } catch (error) {
      unlinkQuietly(file.path);
      const message = error instanceof Error ? error.message : "No se pudo validar el audio.";
      res.status(400).json({ error: message }); return;
    }

    const url = `/api/uploads/${path.basename(finalPath)}`;
    try {
      const clip = await db.transaction(async (tx) => {
        // Serialize concurrent uploads per server so the 24-clip cap cannot race.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('soundboard_clips'), ${serverId})`);
        const [{ total }] = await tx.select({ total: count() }).from(soundboardClipsTable)
          .where(eq(soundboardClipsTable.serverId, serverId));
        if (Number(total) >= MAX_CLIPS_PER_SERVER) return null;
        const [created] = await tx.insert(soundboardClipsTable).values({
          serverId,
          name,
          durationMs: detected.durationMs,
          sizeBytes: file.size,
          mimeType: detected.mimeType,
          url,
          uploadedBy: req.session.userId!,
        }).returning();
        return created;
      });
      if (!clip) {
        unlinkQuietly(finalPath);
        res.status(409).json({ error: `Cada servidor puede tener como máximo ${MAX_CLIPS_PER_SERVER} clips en el soundboard.` });
        return;
      }
      res.status(201).json(serializeClip(clip));
    } catch (error) {
      unlinkQuietly(finalPath);
      throw error;
    }
  },
);

// DELETE /servers/:serverId/soundboard/:clipId
router.delete("/servers/:serverId/soundboard/:clipId", requireAuth, async (req, res): Promise<void> => {
  const serverId = parsePositiveId(req.params.serverId);
  const clipId = parsePositiveId(req.params.clipId);
  if (!serverId || !clipId) { res.status(400).json({ error: "ID de soundboard no válido." }); return; }
  const [clip] = await db.select().from(soundboardClipsTable).where(and(
    eq(soundboardClipsTable.id, clipId),
    eq(soundboardClipsTable.serverId, serverId),
  ));
  if (!clip) { res.status(404).json({ error: "Clip del soundboard no encontrado." }); return; }
  const isAdmin = await canManageServer(req.session.userId!, req.session.userRole, serverId);
  if (clip.uploadedBy !== req.session.userId && !isAdmin) {
    res.status(403).json({ error: "Solo quien subió el clip o un administrador del servidor puede eliminarlo." }); return;
  }
  await db.delete(soundboardClipsTable).where(eq(soundboardClipsTable.id, clipId));
  const filename = path.basename(clip.url);
  if (filename.startsWith("soundboard-")) unlinkQuietly(path.join(UPLOADS_DIR, filename));
  res.sendStatus(204);
});

// GET /soundboard/available?peerId=N
router.get("/soundboard/available", requireAuth, async (req, res): Promise<void> => {
  const peerId = parsePositiveId(req.query.peerId);
  if (!peerId || peerId === req.session.userId) { res.status(400).json({ error: "Se requiere un ID de contacto válido." }); return; }
  const [peer] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, peerId));
  if (!peer) { res.status(404).json({ error: "Contacto no encontrado." }); return; }
  const rows = await db.selectDistinct({ id: serversTable.id, name: serversTable.name })
    .from(serverMembersTable)
    .innerJoin(serversTable, eq(serversTable.id, serverMembersTable.serverId))
    .where(and(
      eq(serverMembersTable.userId, req.session.userId!),
      inArray(serversTable.id, db.select({ serverId: serverMembersTable.serverId }).from(serverMembersTable)
        .where(eq(serverMembersTable.userId, peerId))),
    ));
  res.json(rows);
});

// POST /soundboard/trigger
router.post("/soundboard/trigger", requireAuth, soundboardTriggerRateLimit, async (req, res): Promise<void> => {
  const { clipId, callType, channelId, peerId } = req.body ?? {};
  if (!Number.isSafeInteger(clipId) || clipId < 1 ||
      (callType !== "voice" && callType !== "dm")) {
    res.status(400).json({ error: "Se requieren clipId y callType (voice o dm)." }); return;
  }
  const [clip] = await db.select().from(soundboardClipsTable)
    .where(eq(soundboardClipsTable.id, clipId));
  if (!clip) { res.status(404).json({ error: "Clip del soundboard no encontrado." }); return; }

  let targetId: number;
  if (callType === "voice") {
    if (!Number.isSafeInteger(channelId) || channelId < 1 || peerId !== undefined) {
      res.status(400).json({ error: "Se requiere un ID de canal válido para las llamadas de voz." }); return;
    }
    targetId = channelId;
    const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
    if (!channel || channel.serverId !== clip.serverId || channel.channelType !== "voice") {
      res.status(403).json({ error: "El clip y el canal de voz deben pertenecer al mismo servidor." }); return;
    }
    if (!(await canAccessChannel(channel, req.session.userId!, req.session.userRole))) {
      res.status(403).json({ error: "No tienes acceso a este canal de voz." }); return;
    }
  } else {
    if (!Number.isSafeInteger(peerId) || peerId < 1 || channelId !== undefined || peerId === req.session.userId) {
      res.status(400).json({ error: "Se requiere un ID de contacto válido para las llamadas directas." }); return;
    }
    targetId = peerId;
    const [members] = await db.select({ serverId: serverMembersTable.serverId })
      .from(serverMembersTable)
      .where(and(
        eq(serverMembersTable.serverId, clip.serverId),
        inArray(serverMembersTable.userId, [req.session.userId!, peerId]),
      ))
      .groupBy(serverMembersTable.serverId)
      .having(sql`count(distinct ${serverMembersTable.userId}) = 2`);
    if (!members) {
      res.status(403).json({ error: "Tú y el contacto debéis compartir el servidor del clip." }); return;
    }
  }

  const now = Date.now();
  for (const [userId, triggeredAt] of triggerTimes) {
    if (now - triggeredAt >= TRIGGER_COOLDOWN_MS) triggerTimes.delete(userId);
  }
  const lastTriggered = triggerTimes.get(req.session.userId!);
  if (lastTriggered !== undefined && now - lastTriggered < TRIGGER_COOLDOWN_MS) {
    res.status(429).json({ error: "Solo puedes reproducir un clip del soundboard cada 2 segundos." }); return;
  }
  const [user] = await db.select({ displayName: usersTable.displayName }).from(usersTable)
    .where(eq(usersTable.id, req.session.userId!));
  if (!user) { res.status(401).json({ error: "El usuario autenticado ya no existe." }); return; }

  const event = {
    type: "soundboard:play" as const,
    data: {
      clipId: clip.id,
      serverId: clip.serverId,
      url: serializeClip(clip).url,
      name: clip.name,
      triggeredById: req.session.userId!,
      triggeredByName: user.displayName,
      callType,
      ...(callType === "voice" ? { channelId: targetId } : { peerId: targetId }),
    },
  };
  if (!emitSoundboardToCall(req.session.userId!, callType, targetId, event)) {
    res.status(409).json({ error: "No hay ninguna llamada activa para reproducir este clip." }); return;
  }
  triggerTimes.set(req.session.userId!, now);
  res.json(serializeClip(clip));
});

export default router;