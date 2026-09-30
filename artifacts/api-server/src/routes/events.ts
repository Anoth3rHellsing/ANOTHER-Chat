import { Router, type IRouter } from "express";
import { and, asc, eq, inArray, isNull, gt } from "drizzle-orm";
import {
  db,
  channelsTable,
  channelEventsTable,
  eventResponsesTable,
  messagesTable,
  usersTable,
} from "@workspace/db";
import { requireAuth } from "../lib/auth";
import { encryptMessage } from "../lib/crypto";
import { canAccessChannel, getMemberPermissions, getMembership, hasPerm, PERM } from "../lib/permissions";
import { broadcast, broadcastToUser } from "../lib/websocket";

const router: IRouter = Router();
const MAX_EVENT_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function getParam(value: string | string[]): string {
  return Array.isArray(value) ? value[0] : value;
}

function parseId(value: string | string[]): number | null {
  const id = Number.parseInt(getParam(value), 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function parseIsoInstant(value: unknown): Date | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) return null;

  const datePart = value.slice(0, 10);
  const timePart = value.slice(11, 19);
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute, second] = timePart.split(":").map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const calendarDate = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) return null;
  const offset = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return null;

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : null;
}

function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validFutureCreateStart(date: Date): boolean {
  const now = new Date();
  const latest = new Date(now);
  latest.setUTCFullYear(latest.getUTCFullYear() + 3);
  return date.getTime() > now.getTime() && date.getTime() <= latest.getTime();
}

function validEnd(start: Date, end: Date | null): boolean {
  return end === null || (end.getTime() > start.getTime() && end.getTime() - start.getTime() <= MAX_EVENT_DURATION_MS);
}

async function loadChannel(channelId: number) {
  const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
  return channel;
}

async function loadEvent(channelId: number, eventId: number) {
  const [event] = await db.select().from(channelEventsTable).where(and(
    eq(channelEventsTable.id, eventId),
    eq(channelEventsTable.channelId, channelId),
  ));
  return event;
}

async function canManageEvent(
  channel: typeof channelsTable.$inferSelect,
  event: typeof channelEventsTable.$inferSelect,
  userId: number,
  globalRole: string | undefined,
): Promise<boolean> {
  if (event.creatorId === userId || globalRole === "admin") return true;
  const membership = await getMembership(channel.serverId, userId);
  if (membership?.role === "owner" || membership?.role === "admin") return true;
  const permissions = await getMemberPermissions(channel.serverId, userId);
  return hasPerm(permissions, PERM.MANAGE_CHANNELS);
}

async function serializeEvent(
  event: typeof channelEventsTable.$inferSelect,
  currentUserId: number,
) {
  const [creator] = await db.select().from(usersTable).where(eq(usersTable.id, event.creatorId));
  const rows = await db.select({
    userId: eventResponsesTable.userId,
    status: eventResponsesTable.status,
    updatedAt: eventResponsesTable.updatedAt,
    username: usersTable.username,
    displayName: usersTable.displayName,
    avatarUrl: usersTable.avatarUrl,
  })
    .from(eventResponsesTable)
    .innerJoin(usersTable, eq(eventResponsesTable.userId, usersTable.id))
    .where(eq(eventResponsesTable.eventId, event.id))
    .orderBy(asc(eventResponsesTable.updatedAt));

  const responses = rows.map(row => ({
    userId: row.userId,
    status: row.status,
    user: { name: row.username, displayName: row.displayName, avatarUrl: row.avatarUrl },
    updatedAt: row.updatedAt,
  }));
  const myResponse = responses.find(response => response.userId === currentUserId) ?? null;
  return {
    id: event.id,
    channelId: event.channelId,
    creatorId: event.creatorId,
    creator: {
      id: creator?.id ?? event.creatorId,
      username: creator?.username ?? "",
      displayName: creator?.displayName ?? "",
      avatarUrl: creator?.avatarUrl ?? null,
    },
    title: event.title,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    originalTimeZone: event.originalTimeZone,
    canceledAt: event.canceledAt,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    responses,
    counts: {
      yes: responses.filter(response => response.status === "yes").length,
      no: responses.filter(response => response.status === "no").length,
      maybe: responses.filter(response => response.status === "maybe").length,
    },
    myResponse,
  };
}

async function notifyAttendees(
  channel: typeof channelsTable.$inferSelect,
  event: typeof channelEventsTable.$inferSelect,
  actorId: number,
  priorResponses: Array<{ userId: number; status: string }>,
  type: "event:rescheduled" | "event:attendee_cancelled",
): Promise<void> {
  const userIds = [...new Set(priorResponses
    .filter(response => response.status === "yes" || response.status === "maybe")
    .map(response => response.userId))];
  if (userIds.length === 0) return;
  const users = await db.select({ id: usersTable.id, role: usersTable.role })
    .from(usersTable)
    .where(inArray(usersTable.id, userIds));
  for (const user of users) {
    if (await canAccessChannel(channel, user.id, user.role ?? undefined)) {
      broadcastToUser(user.id, {
        type,
        data: {
          id: event.id,
          eventId: event.id,
          channelId: channel.id,
          serverId: channel.serverId,
          title: event.title,
          startsAt: event.startsAt,
          actorId,
        },
      });
    }
  }
}

function broadcastEvent(
  type: "event:created" | "event:updated" | "event:cancelled" | "event:rsvp_updated",
  event: typeof channelEventsTable.$inferSelect,
  serverId: number,
): void {
  broadcast(`channel:${event.channelId}`, {
    type,
    data: { eventId: event.id, channelId: event.channelId, serverId },
  });
}

// GET /events/upcoming/mine
router.get("/events/upcoming/mine", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const now = new Date();
  const myRows = await db.select({
    eventId: eventResponsesTable.eventId,
    status: eventResponsesTable.status,
  }).from(eventResponsesTable).where(and(
    eq(eventResponsesTable.userId, userId),
    inArray(eventResponsesTable.status, ["yes", "maybe"]),
  ));
  if (myRows.length === 0) {
    res.json([]);
    return;
  }
  const eventIds = myRows.map(row => row.eventId);
  const events = await db.select().from(channelEventsTable).where(and(
    inArray(channelEventsTable.id, eventIds),
    gt(channelEventsTable.startsAt, now),
    isNull(channelEventsTable.canceledAt),
  )).orderBy(asc(channelEventsTable.startsAt));

  const result = [];
  for (const event of events) {
    const channel = await loadChannel(event.channelId);
    if (!channel || !(await canAccessChannel(channel, userId, req.session.userRole))) continue;
    result.push(await serializeEvent(event, userId));
  }
  res.json(result);
});

// GET /channels/:channelId/events
router.get("/channels/:channelId/events", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const channelId = parseId(req.params.channelId);
  if (!channelId) { res.status(400).json({ error: "Identificador de canal inválido" }); return; }
  const channel = await loadChannel(channelId);
  if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }
  if (!(await canAccessChannel(channel, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes acceso a este canal" }); return;
  }
  const events = await db.select().from(channelEventsTable)
    .where(eq(channelEventsTable.channelId, channelId))
    .orderBy(asc(channelEventsTable.startsAt));
  res.json(await Promise.all(events.map(event => serializeEvent(event, userId))));
});

// POST /channels/:channelId/events
router.post("/channels/:channelId/events", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const channelId = parseId(req.params.channelId);
  if (!channelId) { res.status(400).json({ error: "Identificador de canal inválido" }); return; }
  const channel = await loadChannel(channelId);
  if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }
  if (!(await canAccessChannel(channel, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes acceso a este canal" }); return;
  }

  const body = req.body ?? {};
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = body.description == null ? null : body.description;
  const startsAt = parseIsoInstant(body.startsAt);
  const endsAt = body.endsAt == null ? null : parseIsoInstant(body.endsAt);
  if (!title || title.length > 120) { res.status(400).json({ error: "El título debe tener entre 1 y 120 caracteres" }); return; }
  if (description !== null && (typeof description !== "string" || description.length > 2000)) {
    res.status(400).json({ error: "La descripción no puede superar los 2000 caracteres" }); return;
  }
  if (!startsAt || !validFutureCreateStart(startsAt)) {
    res.status(400).json({ error: "La fecha de inicio debe ser una fecha y hora completas, futura y dentro de los próximos tres años" }); return;
  }
  if (body.endsAt != null && !endsAt) { res.status(400).json({ error: "La fecha de fin debe ser una fecha y hora completas" }); return; }
  if (!validEnd(startsAt, endsAt)) {
    res.status(400).json({ error: "El fin debe ser posterior al inicio y como máximo siete días después" }); return;
  }
  if (!isValidTimeZone(body.originalTimeZone)) {
    res.status(400).json({ error: "La zona horaria no es válida" }); return;
  }

  const [author] = channel.channelType === "calendar"
    ? [undefined]
    : await db.select().from(usersTable).where(eq(usersTable.id, userId));
  const announcement = (eventId: number) => `Nueva actividad: ${title}\n[event:${eventId}]`;
  const { event, message } = await db.transaction(async tx => {
    const [createdEvent] = await tx.insert(channelEventsTable).values({
      channelId,
      creatorId: userId,
      title,
      description,
      startsAt,
      endsAt,
      originalTimeZone: body.originalTimeZone,
    }).returning();
    // Text channels have a message timeline for event announcements; calendar
    // channels present events as their main content and do not store an unseen
    // encrypted message that would otherwise inflate their unread count.
    if (channel.channelType === "calendar") return { event: createdEvent, message: null };
    const { encrypted, iv } = encryptMessage(announcement(createdEvent.id));
    const [createdMessage] = await tx.insert(messagesTable).values({
      channelId,
      userId,
      contentEncrypted: encrypted,
      iv,
      replyToId: null,
    }).returning();
    return { event: createdEvent, message: createdMessage };
  });

  const response = await serializeEvent(event, userId);
  broadcastEvent("event:created", event, channel.serverId);
  if (message) {
    broadcast(`channel:${channelId}`, {
      type: "message:new",
      data: {
        id: message.id,
        channelId,
        userId,
        content: announcement(event.id),
        replyToId: null,
        editedAt: null,
        deletedAt: null,
        createdAt: message.createdAt,
        author: author ? {
          id: author.id,
          username: author.username,
          displayName: author.displayName,
          bio: author.bio,
          avatarUrl: author.avatarUrl,
          bannerUrl: author.bannerUrl,
          status: author.status,
          role: author.role,
          createdAt: author.createdAt,
        } : null,
        attachments: [],
        reactions: [],
        replyTo: null,
        linkPreview: null,
      },
    });
  }
  res.status(201).json(response);
});

// GET /channels/:channelId/events/:eventId
router.get("/channels/:channelId/events/:eventId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const channelId = parseId(req.params.channelId);
  const eventId = parseId(req.params.eventId);
  if (!channelId || !eventId) { res.status(400).json({ error: "Identificador de canal o de evento inválido" }); return; }
  const channel = await loadChannel(channelId);
  if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }
  if (!(await canAccessChannel(channel, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes acceso a este canal" }); return;
  }
  const event = await loadEvent(channelId, eventId);
  if (!event) { res.status(404).json({ error: "Evento no encontrado" }); return; }
  res.json(await serializeEvent(event, userId));
});

// PATCH /channels/:channelId/events/:eventId
router.patch("/channels/:channelId/events/:eventId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const channelId = parseId(req.params.channelId);
  const eventId = parseId(req.params.eventId);
  if (!channelId || !eventId) { res.status(400).json({ error: "Identificador de canal o de evento inválido" }); return; }
  const channel = await loadChannel(channelId);
  if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }
  if (!(await canAccessChannel(channel, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes acceso a este canal" }); return;
  }

  const body = req.body ?? {};
  if (Object.keys(body).length === 0) {
    res.status(400).json({ error: "Indica al menos un campo del evento para modificar" }); return;
  }
  const result = await db.transaction(async tx => {
    const [event] = await tx.select().from(channelEventsTable)
      .where(and(eq(channelEventsTable.id, eventId), eq(channelEventsTable.channelId, channelId)))
      .for("update");
    if (!event) return { error: "not_found" as const };
    if (!(await canManageEvent(channel, event, userId, req.session.userRole))) return { error: "forbidden" as const };
    if (event.canceledAt) return { error: "canceled" as const };

    let title = event.title;
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 120) {
        return { error: "title" as const };
      }
      title = body.title.trim();
    }
    let description = event.description;
    if (body.description !== undefined) {
      if (body.description !== null && (typeof body.description !== "string" || body.description.length > 2000)) {
        return { error: "description" as const };
      }
      description = body.description;
    }
    let startsAt = event.startsAt;
    if (body.startsAt !== undefined) {
      const parsed = parseIsoInstant(body.startsAt);
      if (!parsed) return { error: "startsAt" as const };
      if (!validFutureCreateStart(parsed)) return { error: "startRange" as const };
      startsAt = parsed;
    }
    let endsAt = event.endsAt;
    if (body.endsAt !== undefined) {
      if (body.endsAt === null) endsAt = null;
      else {
        const parsed = parseIsoInstant(body.endsAt);
        if (!parsed) return { error: "endsAt" as const };
        endsAt = parsed;
      }
    }
    let originalTimeZone = event.originalTimeZone;
    if (body.originalTimeZone !== undefined) {
      if (!isValidTimeZone(body.originalTimeZone)) return { error: "timeZone" as const };
      originalTimeZone = body.originalTimeZone;
    }
    if (!validEnd(startsAt, endsAt)) return { error: "duration" as const };

    const scheduleChanged =
      startsAt.getTime() !== event.startsAt.getTime() ||
      (endsAt?.getTime() ?? null) !== (event.endsAt?.getTime() ?? null);
    const priorResponses = scheduleChanged
      ? await tx.select({
          userId: eventResponsesTable.userId,
          status: eventResponsesTable.status,
        }).from(eventResponsesTable).where(eq(eventResponsesTable.eventId, event.id))
      : [];
    if (scheduleChanged) {
      // A schedule change invalidates every prior RSVP: yes/maybe attendees are
      // individually notified after commit so they can make a fresh decision.
      await tx.delete(eventResponsesTable).where(eq(eventResponsesTable.eventId, event.id));
    }
    const [updated] = await tx.update(channelEventsTable).set({
      title,
      description,
      startsAt,
      endsAt,
      originalTimeZone,
      updatedAt: new Date(),
    }).where(eq(channelEventsTable.id, event.id)).returning();
    return { event: updated, priorResponses, scheduleChanged };
  });

  if ("error" in result) {
    if (result.error === "not_found") { res.status(404).json({ error: "Evento no encontrado" }); return; }
    if (result.error === "forbidden") { res.status(403).json({ error: "No puedes gestionar este evento" }); return; }
    if (result.error === "canceled") { res.status(409).json({ error: "Un evento cancelado no se puede editar" }); return; }
    const errors: Record<string, string> = {
      title: "El título debe tener entre 1 y 120 caracteres",
      description: "La descripción no puede superar los 2000 caracteres",
      startsAt: "La fecha de inicio debe ser una fecha y hora completas",
      startRange: "La fecha de inicio debe ser futura y dentro de los próximos tres años",
      endsAt: "La fecha de fin debe ser una fecha y hora completas",
      timeZone: "La zona horaria no es válida",
      duration: "El fin debe ser posterior al inicio y como máximo siete días después",
    };
    res.status(400).json({ error: errors[String(result.error)] ?? "Evento inválido" });
    return;
  }

  if (result.scheduleChanged) {
    await notifyAttendees(channel, result.event, userId, result.priorResponses, "event:rescheduled");
  }
  broadcastEvent("event:updated", result.event, channel.serverId);
  res.json(await serializeEvent(result.event, userId));
});

// DELETE /channels/:channelId/events/:eventId (soft cancellation)
router.delete("/channels/:channelId/events/:eventId", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const channelId = parseId(req.params.channelId);
  const eventId = parseId(req.params.eventId);
  if (!channelId || !eventId) { res.status(400).json({ error: "Identificador de canal o de evento inválido" }); return; }
  const channel = await loadChannel(channelId);
  if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }
  if (!(await canAccessChannel(channel, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes acceso a este canal" }); return;
  }

  const result = await db.transaction(async tx => {
    const [event] = await tx.select().from(channelEventsTable)
      .where(and(eq(channelEventsTable.id, eventId), eq(channelEventsTable.channelId, channelId)))
      .for("update");
    if (!event) return { error: "not_found" as const };
    if (!(await canManageEvent(channel, event, userId, req.session.userRole))) return { error: "forbidden" as const };
    if (event.canceledAt) return { error: "canceled" as const };
    const priorResponses = await tx.select({
      userId: eventResponsesTable.userId,
      status: eventResponsesTable.status,
    }).from(eventResponsesTable).where(eq(eventResponsesTable.eventId, event.id));
    const [updated] = await tx.update(channelEventsTable)
      .set({ canceledAt: new Date(), updatedAt: new Date() })
      .where(eq(channelEventsTable.id, event.id))
      .returning();
    return { event: updated, priorResponses };
  });
  if ("error" in result) {
    if (result.error === "not_found") { res.status(404).json({ error: "Evento no encontrado" }); return; }
    if (result.error === "forbidden") { res.status(403).json({ error: "No puedes gestionar este evento" }); return; }
    res.status(409).json({ error: "El evento ya está cancelado" });
    return;
  }
  await notifyAttendees(channel, result.event, userId, result.priorResponses, "event:attendee_cancelled");
  broadcastEvent("event:cancelled", result.event, channel.serverId);
  res.json(await serializeEvent(result.event, userId));
});

// PUT /channels/:channelId/events/:eventId/response
router.put("/channels/:channelId/events/:eventId/response", requireAuth, async (req, res): Promise<void> => {
  const userId = req.session.userId!;
  const channelId = parseId(req.params.channelId);
  const eventId = parseId(req.params.eventId);
  if (!channelId || !eventId) { res.status(400).json({ error: "Identificador de canal o de evento inválido" }); return; }
  const channel = await loadChannel(channelId);
  if (!channel) { res.status(404).json({ error: "Canal no encontrado" }); return; }
  if (!(await canAccessChannel(channel, userId, req.session.userRole))) {
    res.status(403).json({ error: "No tienes acceso a este canal" }); return;
  }
  const status = req.body?.status;
  if (status !== "yes" && status !== "no" && status !== "maybe") {
    res.status(400).json({ error: "La respuesta debe ser sí, no o quizás" }); return;
  }

  const event = await db.transaction(async tx => {
    const [locked] = await tx.select().from(channelEventsTable)
      .where(and(eq(channelEventsTable.id, eventId), eq(channelEventsTable.channelId, channelId)))
      .for("update");
    if (!locked) return { error: "not_found" as const };
    if (locked.canceledAt) return { error: "canceled" as const };
    if (locked.startsAt.getTime() <= Date.now()) return { error: "past" as const };
    const now = new Date();
    await tx.insert(eventResponsesTable).values({
      eventId,
      userId,
      status,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [eventResponsesTable.eventId, eventResponsesTable.userId],
      set: { status, updatedAt: now },
    });
    return locked;
  });
  if ("error" in event) {
    if (event.error === "not_found") { res.status(404).json({ error: "Evento no encontrado" }); return; }
    res.status(409).json({ error: event.error === "past" ? "Un evento pasado no admite respuestas" : "Un evento cancelado no admite respuestas" });
    return;
  }
  broadcastEvent("event:rsvp_updated", event, channel.serverId);
  res.json(await serializeEvent(event, userId));
});

export default router;