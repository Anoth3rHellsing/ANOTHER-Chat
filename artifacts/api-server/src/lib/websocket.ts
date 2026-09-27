import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "http";
import type { Server as HttpServer } from "http";
import type { SessionData } from "express-session";
import { and, eq } from "drizzle-orm";
import { db, channelsTable, usersTable, serverMembersTable } from "@workspace/db";
import { canAccessChannel } from "./permissions";
import { logger } from "./logger";
import { randomUUID } from "crypto";
import cookieParser from "cookie-parser";
import { SESSION_SECRET } from "./session-config";
import {
  WatchSessionStore,
  advanceWatchCursor,
  canControlWatchAction,
  createWatchItem,
  getExpectedWatchPosition,
  isWatchPosition,
  normalizeWatchLink,
  isActiveWatchCallParticipant,
  MAX_WATCH_QUEUE_SIZE,
  type WatchScope,
  type WatchSession,
  type WatchControlAction,
} from "./watch-sessions";

const MAX_PENDING_AUTH_MESSAGES = 100;
const MAX_PENDING_AUTH_BYTES = 1_000_000;
const AUTH_RESOLUTION_TIMEOUT_MS = 5_000;
const VOICE_BIND_RESERVATION_MS = 30_000;
const DM_CALL_INVITE_TTL_MS = 60_000;
const DM_CALL_ACTIVE_TTL_MS = 12 * 60 * 60 * 1_000;

interface AuthedWebSocket extends WebSocket {
  connectionId: string;
  userId?: number;
  userRole?: string;
  subscriptions: Set<string>;
  isAlive: boolean;
}

let wss: WebSocketServer | null = null;

// ── Presence: track active WS connections per user ─────────────────────────
const userConnectionCounts = new Map<number, number>();
const lastSeenThrottleMap = new Map<number, number>();
const LAST_SEEN_THROTTLE_MS = 60_000; // update at most once per minute

async function updateUserPresence(userId: number, status: "online" | "offline"): Promise<void> {
  try {
    if (status === "offline") {
      const [row] = await db.update(usersTable)
        .set({ status: "offline", lastSeenAt: new Date() })
        .where(eq(usersTable.id, userId))
        .returning({ invisible: usersTable.invisible });
      // Un usuario invisible ya se mostraba desconectado: no hay nada que anunciar.
      if (!row || row.invisible) return;
    } else {
      // Modo invisible ("Desconectado"): conectarse nunca lo pasa a online.
      const [row] = await db.update(usersTable)
        .set({ status: "online" })
        .where(and(eq(usersTable.id, userId), eq(usersTable.invisible, false)))
        .returning({ id: usersTable.id });
      if (!row) return;
    }
    // user:status es el evento que el cliente ya escucha para refrescar las listas de miembros.
    broadcastAll({ type: "user:status", data: { userId, status } });
  } catch (err) {
    logger.error({ err, userId, status }, "Failed to update user presence");
  }
}

async function throttleLastSeenUpdate(userId: number): Promise<void> {
  const now = Date.now();
  const last = lastSeenThrottleMap.get(userId) ?? 0;
  if (now - last < LAST_SEEN_THROTTLE_MS) return;
  lastSeenThrottleMap.set(userId, now);
  try {
    await db.update(usersTable)
      .set({ lastSeenAt: new Date() })
      .where(eq(usersTable.id, userId));
  } catch (err) {
    logger.error({ err, userId }, "Failed to update last_seen_at");
  }
}

// ── In-memory voice channel state ──────────────────────────────────────────
// channelId → userId → connectionIds
const voiceChannelMembersMap = new Map<number, Map<number, Set<string>>>();
const voiceBindReservationTimers = new Map<string, ReturnType<typeof setTimeout>>();

function voiceMembershipKey(channelId: number, userId: number): string {
  return `${channelId}:${userId}`;
}

function clearVoiceBindReservation(channelId: number, userId: number): void {
  const key = voiceMembershipKey(channelId, userId);
  const timer = voiceBindReservationTimers.get(key);
  if (timer) clearTimeout(timer);
  voiceBindReservationTimers.delete(key);
}

export function joinVoiceChannel(channelId: number, userId: number): void {
  if (!voiceChannelMembersMap.has(channelId)) {
    voiceChannelMembersMap.set(channelId, new Map());
  }
  const members = voiceChannelMembersMap.get(channelId)!;
  if (!members.has(userId)) members.set(userId, new Set());
  const connections = members.get(userId)!;
  if (connections.size === 0) {
    clearVoiceBindReservation(channelId, userId);
    const key = voiceMembershipKey(channelId, userId);
    voiceBindReservationTimers.set(key, setTimeout(() => {
      voiceBindReservationTimers.delete(key);
      const currentMembers = voiceChannelMembersMap.get(channelId);
      const currentConnections = currentMembers?.get(userId);
      if (!currentMembers || !currentConnections || currentConnections.size > 0) return;
      currentMembers.delete(userId);
      if (currentMembers.size === 0) voiceChannelMembersMap.delete(channelId);
    }, VOICE_BIND_RESERVATION_MS));
  }
}

export function leaveVoiceChannel(channelId: number, userId: number): boolean {
  const members = voiceChannelMembersMap.get(channelId);
  const connections = members?.get(userId);
  if (!members || !connections || connections.size > 0) return false;
  clearVoiceBindReservation(channelId, userId);
  members.delete(userId);
  if (members.size === 0) {
    voiceChannelMembersMap.delete(channelId);
    watchSessions.end("voice", channelId);
  } else {
    removeVoiceWatchParticipant(channelId, userId);
  }
  return true;
}

export function getVoiceChannelMembers(channelId: number): Set<number> {
  return new Set(voiceChannelMembersMap.get(channelId)?.keys() ?? []);
}

export function getAllVoiceChannelsForUser(userId: number): number[] {
  const result: number[] = [];
  voiceChannelMembersMap.forEach((members, channelId) => {
    if (members.has(userId)) result.push(channelId);
  });
  return result;
}

function bindVoiceConnection(
  channelId: number,
  userId: number,
  connectionId: string,
): { accepted: boolean; newConnection: boolean } {
  const connections = voiceChannelMembersMap.get(channelId)?.get(userId);
  if (!connections) return { accepted: false, newConnection: false };
  const newConnection = !connections.has(connectionId);
  connections.add(connectionId);
  clearVoiceBindReservation(channelId, userId);
  return { accepted: true, newConnection };
}

function hasVoiceMembership(channelId: number, userId: number): boolean {
  return voiceChannelMembersMap.get(channelId)?.has(userId) ?? false;
}

function unbindVoiceConnection(
  channelId: number,
  userId: number,
  connectionId: string,
): boolean {
  const members = voiceChannelMembersMap.get(channelId);
  const connections = members?.get(userId);
  if (!members || !connections || !connections.delete(connectionId)) return false;
  if (connections.size > 0) return false;
  members.delete(userId);
  clearVoiceBindReservation(channelId, userId);
  if (members.size === 0) {
    voiceChannelMembersMap.delete(channelId);
    watchSessions.end("voice", channelId);
  } else {
    removeVoiceWatchParticipant(channelId, userId);
  }
  return true;
}

function getVoiceChannelsForConnection(userId: number, connectionId: string): number[] {
  const result: number[] = [];
  voiceChannelMembersMap.forEach((members, channelId) => {
    if (members.get(userId)?.has(connectionId)) result.push(channelId);
  });
  return result;
}

function getVoiceTargetConnection(
  sourceUserId: number,
  sourceConnectionId: string,
  targetUserId: number,
): { connectionId: string; channelId: number } | null {
  for (const channelId of getVoiceChannelsForConnection(sourceUserId, sourceConnectionId)) {
    const targetConnections = voiceChannelMembersMap.get(channelId)?.get(targetUserId);
    const targetConnectionId = targetConnections?.values().next().value;
    if (targetConnectionId) return { connectionId: targetConnectionId, channelId };
  }
  return null;
}

type DmCallRoute = {
  callerUserId: number;
  callerConnectionId: string;
  recipientUserId: number;
  recipientConnectionId: string;
  active: boolean;
  expiryTimer: ReturnType<typeof setTimeout>;
};

const dmCallRoutes = new Map<string, DmCallRoute>();
const watchSessions = new WatchSessionStore();

function dmCallKey(userA: number, userB: number): string {
  return userA < userB ? `${userA}:${userB}` : `${userB}:${userA}`;
}

function clearDmCallRoute(key: string): void {
  const route = dmCallRoutes.get(key);
  if (route) clearTimeout(route.expiryTimer);
  dmCallRoutes.delete(key);
}

function setDmCallRoute(
  route: Omit<DmCallRoute, "expiryTimer" | "active">,
  ttlMs: number,
  active = false,
): void {
  const key = dmCallKey(route.callerUserId, route.recipientUserId);
  clearDmCallRoute(key);
  dmCallRoutes.set(key, {
    ...route,
    active,
    expiryTimer: setTimeout(() => {
      const current = dmCallRoutes.get(key);
      if (!current || current.callerConnectionId !== route.callerConnectionId
        || current.recipientConnectionId !== route.recipientConnectionId) return;
      endDmWatchSession(current);
      clearDmCallRoute(key);
    }, ttlMs),
  });
}

function markDmCallRouteActive(userA: number, userB: number): void {
  const key = dmCallKey(userA, userB);
  const route = dmCallRoutes.get(key);
  if (!route) return;
  setDmCallRoute({
    callerUserId: route.callerUserId,
    callerConnectionId: route.callerConnectionId,
    recipientUserId: route.recipientUserId,
    recipientConnectionId: route.recipientConnectionId,
  }, DM_CALL_ACTIVE_TTL_MS, true);
}

function getActiveDmRouteForClient(client: AuthedWebSocket, peerId: number): DmCallRoute | null {
  if (!client.userId || peerId === client.userId) return null;
  const route = dmCallRoutes.get(dmCallKey(client.userId, peerId));
  if (!route?.active) return null;
  const isCallerConnection = route.callerUserId === client.userId
    && route.callerConnectionId === client.connectionId
    && route.recipientUserId === peerId;
  const isRecipientConnection = route.recipientUserId === client.userId
    && route.recipientConnectionId === client.connectionId
    && route.callerUserId === peerId;
  return isCallerConnection || isRecipientConnection ? route : null;
}

function isWatchMemberConnection(client: AuthedWebSocket, scope: WatchScope, targetId: number): boolean {
  if (!client.userId || !Number.isSafeInteger(targetId) || targetId <= 0) return false;
  if (scope === "voice") {
    return voiceChannelMembersMap.get(targetId)?.get(client.userId)?.has(client.connectionId) ?? false;
  }
  return getActiveDmRouteForClient(client, targetId) !== null;
}

function sendWatchStateToConnection(
  client: AuthedWebSocket,
  scope: WatchScope,
  targetId: number,
): void {
  if (!client.userId || client.readyState !== WebSocket.OPEN) return;
  const snapshot = watchSessions.snapshot(scope, targetId, Date.now(), client.userId);
  client.send(JSON.stringify({
    type: "watch:state",
    data: { scope, targetId, session: snapshot },
  }));
}

function broadcastWatchState(
  scope: WatchScope,
  targetId: number,
  peerId?: number,
): void {
  if (scope === "voice") {
    const members = voiceChannelMembersMap.get(targetId);
    if (!members) return;
    for (const [userId, connectionIds] of members) {
      for (const connectionId of connectionIds) {
        const client = findOpenConnection(connectionId, userId);
        if (client) sendWatchStateToConnection(client, scope, targetId);
      }
    }
    return;
  }

  if (peerId === undefined || !wss) return;
  const route = dmCallRoutes.get(dmCallKey(targetId, peerId));
  if (!route?.active) return;
  const caller = findOpenConnection(route.callerConnectionId, route.callerUserId);
  if (caller) sendWatchStateToConnection(caller, "dm", route.recipientUserId);
  const recipient = findOpenConnection(route.recipientConnectionId, route.recipientUserId);
  if (recipient) sendWatchStateToConnection(recipient, "dm", route.callerUserId);
}

function removeVoiceWatchParticipant(channelId: number, departedUserId: number): void {
  const session = watchSessions.get("voice", channelId);
  if (!session) return;
  watchSessions.leave("voice", channelId, departedUserId);
  broadcastWatchState("voice", channelId);
}

function dropWatchSessionWhenVoiceEmpty(channelId: number): void {
  const members = voiceChannelMembersMap.get(channelId);
  const hasConnectedMember = members && [...members.values()].some(connections => connections.size > 0);
  if (!hasConnectedMember) watchSessions.end("voice", channelId);
}

function endDmWatchSession(route: DmCallRoute): void {
  if (!route.active || !watchSessions.end("dm", route.callerUserId, route.recipientUserId)) return;
  const caller = findOpenConnection(route.callerConnectionId, route.callerUserId);
  if (caller) sendWatchStateToConnection(caller, "dm", route.recipientUserId);
  const recipient = findOpenConnection(route.recipientConnectionId, route.recipientUserId);
  if (recipient) sendWatchStateToConnection(recipient, "dm", route.callerUserId);
}

function sendWatchError(
  client: AuthedWebSocket,
  message: string,
  scope?: WatchScope,
  targetId?: number,
): void {
  if (client.readyState !== WebSocket.OPEN) return;
  client.send(JSON.stringify({
    type: "watch:error",
    data: {
      message,
      ...(scope ? { scope } : {}),
      ...(targetId !== undefined ? { targetId } : {}),
    },
  }));
}

async function getWatchActorName(userId: number): Promise<string> {
  const [user] = await db.select({ displayName: usersTable.displayName })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  if (!user) throw new Error("No se encontró el perfil de quien añadió el contenido.");
  return user.displayName;
}

function isWatchParticipant(
  scope: WatchScope,
  targetId: number,
  userId: number,
  actorUserId?: number,
): boolean {
  if (scope === "voice") {
    return [...(voiceChannelMembersMap.get(targetId)?.get(userId) ?? [])]
      .some(connectionId => findOpenConnection(connectionId, userId) !== null);
  }
  if (actorUserId === undefined) return false;
  const route = dmCallRoutes.get(dmCallKey(actorUserId, targetId));
  if (!route || !isActiveWatchCallParticipant(route, userId, actorUserId, targetId)) return false;
  if (route.callerUserId === userId) {
    return findOpenConnection(route.callerConnectionId, userId) !== null;
  }
  if (route.recipientUserId === userId) {
    return findOpenConnection(route.recipientConnectionId, userId) !== null;
  }
  return false;
}

function validateWatchPosition(position: unknown, current: WatchSession["current"]): number {
  if (!isWatchPosition(position) || !Number.isSafeInteger(position)) {
    throw new Error("La posición de reproducción no es válida.");
  }
  return current?.durationMs === undefined
    ? position
    : Math.min(position, current.durationMs);
}

async function processWatchMessage(client: AuthedWebSocket, msg: Record<string, unknown>): Promise<void> {
  const scope = msg.scope === "voice" || msg.scope === "dm" ? msg.scope : null;
  const targetId = msg.targetId;
  if (!client.userId || !scope || !Number.isSafeInteger(targetId) || Number(targetId) <= 0) {
    sendWatchError(client, "La sesión o llamada indicada no es válida.");
    return;
  }
  const id = Number(targetId);
  if (client.readyState !== WebSocket.OPEN || !isWatchMemberConnection(client, scope, id)) {
    sendWatchError(client, "Debes estar conectado a esa llamada para usar la sesión compartida.", scope, id);
    return;
  }
  try {
    if (msg.type === "watch:sync") {
      sendWatchStateToConnection(client, scope, id);
      return;
    }

    if (msg.type === "watch:join") {
      if (!watchSessions.join(scope, id, client.userId, client.userId)) {
        throw new Error("No hay una sesión compartida activa a la que unirse.");
      }
      broadcastWatchState(scope, id, client.userId);
      return;
    }

    if (msg.type === "watch:leave") {
      if (!watchSessions.has(scope, id, client.userId)) {
        throw new Error("No hay una sesión compartida activa de la que salir.");
      }
      watchSessions.leave(scope, id, client.userId, client.userId);
      broadcastWatchState(scope, id, client.userId);
      return;
    }

    if (msg.type === "watch:start") {
      const link = normalizeWatchLink(msg.url);
      const actorName = await getWatchActorName(client.userId);
      if (client.readyState !== WebSocket.OPEN || !isWatchMemberConnection(client, scope, id)) {
        throw new Error("Debes seguir conectado a esa llamada para iniciar una sesión compartida.");
      }
      if (watchSessions.has(scope, id, client.userId)) {
        throw new Error("Ya hay una sesión compartida activa; puedes añadir contenido a su cola.");
      }
      const item = createWatchItem(link, client.userId, actorName);
      watchSessions.start(scope, id, client.userId, item, Date.now(), client.userId);
      broadcastWatchState(scope, id, client.userId);
      return;
    }

    if (msg.type === "watch:add") {
      const link = normalizeWatchLink(msg.url);
      const actorName = await getWatchActorName(client.userId);
      if (client.readyState !== WebSocket.OPEN || !isWatchMemberConnection(client, scope, id)) {
        throw new Error("Debes seguir conectado a esa llamada para añadir contenido.");
      }
      const existing = watchSessions.get(scope, id, client.userId);
      if (!existing) throw new Error("No hay una sesión compartida activa.");
      if (existing.queue.length >= MAX_WATCH_QUEUE_SIZE) {
        throw new Error(`La cola compartida admite como máximo ${MAX_WATCH_QUEUE_SIZE} elementos.`);
      }
      advanceWatchCursor(existing, Date.now());
      existing.queue.push(createWatchItem(link, client.userId, actorName));
      watchSessions.save(scope, id, existing, client.userId);
      broadcastWatchState(scope, id, client.userId);
      return;
    }

    const existing = watchSessions.get(scope, id, client.userId);
    if (!existing) throw new Error("No hay una sesión compartida activa.");

    if (msg.type !== "watch:control" || typeof msg.action !== "string") {
      throw new Error("La acción de la sesión compartida no es válida.");
    }
    const actions: readonly WatchControlAction[] = [
      "play", "pause", "seek", "skip", "reorder", "remove", "transfer",
      "everyone", "end", "ended", "metadata",
    ];
    if (!actions.includes(msg.action as WatchControlAction)) {
      throw new Error("La acción de la sesión compartida no está admitida.");
    }
    const action = msg.action as WatchControlAction;
    if (!watchSessions.isWatching(scope, id, client.userId, client.userId)) {
      throw new Error("Únete al visionado para controlar la reproducción.");
    }
    if (!canControlWatchAction(existing, client.userId, action)) {
      throw new Error("No tienes el control de esta sesión compartida.");
    }
    const now = Date.now();
    advanceWatchCursor(existing, now);
    switch (action) {
      case "play":
        if (!existing.current) throw new Error("No hay contenido actual para reproducir.");
        existing.positionMs = msg.positionMs === undefined
          ? getExpectedWatchPosition(existing, now)
          : validateWatchPosition(msg.positionMs, existing.current);
        existing.playing = true;
        existing.updatedAtMs = now;
        break;
      case "pause":
        if (!existing.current) throw new Error("No hay contenido actual para pausar.");
        existing.positionMs = getExpectedWatchPosition(existing, now);
        existing.playing = false;
        existing.updatedAtMs = now;
        break;
      case "seek":
        if (!existing.current) throw new Error("No hay contenido actual para desplazarse.");
        existing.positionMs = validateWatchPosition(msg.positionMs, existing.current);
        existing.updatedAtMs = now;
        break;
      case "skip":
        existing.current = existing.queue.shift() ?? null;
        existing.positionMs = 0;
        existing.updatedAtMs = now;
        if (!existing.current) existing.playing = false;
        break;
      case "ended":
        if (!existing.current || msg.itemId !== existing.current.id) return;
        existing.current = existing.queue.shift() ?? null;
        existing.positionMs = 0;
        existing.playing = existing.current !== null;
        existing.updatedAtMs = now;
        break;
      case "reorder": {
        const fromIndex = existing.queue.findIndex(item => item.id === msg.itemId);
        if (fromIndex < 0) throw new Error("Ese elemento ya no está en la cola.");
        if (!Number.isSafeInteger(msg.toIndex) || Number(msg.toIndex) < 0
          || Number(msg.toIndex) >= existing.queue.length) {
          throw new Error("La nueva posición en la cola no es válida.");
        }
        const [item] = existing.queue.splice(fromIndex, 1);
        existing.queue.splice(Number(msg.toIndex), 0, item);
        break;
      }
      case "remove": {
        const queueIndex = existing.queue.findIndex(item => item.id === msg.itemId);
        if (queueIndex >= 0) {
          existing.queue.splice(queueIndex, 1);
        } else if (existing.current?.id === msg.itemId) {
          existing.current = existing.queue.shift() ?? null;
          existing.positionMs = 0;
          if (!existing.current) existing.playing = false;
          existing.updatedAtMs = now;
        } else {
          throw new Error("Ese elemento ya no está en la sesión.");
        }
        break;
      }
      case "transfer":
        if (!Number.isSafeInteger(msg.userId) || Number(msg.userId) <= 0
          || !watchSessions.isWatching(scope, id, Number(msg.userId), client.userId)
          || !isWatchParticipant(scope, id, Number(msg.userId), client.userId)) {
          throw new Error("Solo puedes ceder el control a alguien que esté viendo y siga en la llamada.");
        }
        existing.controllerUserId = Number(msg.userId);
        break;
      case "everyone":
        if (typeof msg.allowEveryone !== "boolean") {
          throw new Error("Indica si quieres permitir controles a todos.");
        }
        existing.allowEveryone = msg.allowEveryone;
        break;
      case "end":
        watchSessions.end(scope, id, client.userId);
        broadcastWatchState(scope, id, client.userId);
        return;
      case "metadata": {
        if (!existing.current || msg.itemId !== existing.current.id) {
          throw new Error("El reproductor ya no muestra ese contenido.");
        }
        if (msg.title !== undefined) {
          if (typeof msg.title !== "string" || !msg.title.trim() || msg.title.length > 200) {
            throw new Error("El título informado no es válido.");
          }
          existing.current.title = msg.title.trim();
        }
        if (msg.durationMs !== undefined) {
          if (!Number.isSafeInteger(msg.durationMs) || Number(msg.durationMs) <= 0
            || Number(msg.durationMs) > 604_800_000) {
            throw new Error("La duración informada no es válida.");
          }
          existing.current.durationMs = Number(msg.durationMs);
          existing.positionMs = Math.min(existing.positionMs, existing.current.durationMs);
        }
        break;
      }
      default:
        throw new Error("La acción de la sesión compartida no está admitida.");
    }
    existing.updatedAtMs = now;
    watchSessions.save(scope, id, existing, client.userId);
    broadcastWatchState(scope, id, client.userId);
  } catch (error) {
    sendWatchError(
      client,
      error instanceof Error ? error.message : "No se pudo actualizar la sesión compartida.",
      scope,
      id,
    );
  }
}

export function initWebSocket(server: HttpServer): void {
  wss = new WebSocketServer({
    server,
    path: "/ws",
    maxPayload: MAX_PENDING_AUTH_BYTES,
  });

  // Heartbeat interval to detect dead connections
  const heartbeat = setInterval(() => {
    wss!.clients.forEach((ws) => {
      const client = ws as AuthedWebSocket;
      if (!client.isAlive) {
        client.terminate();
        return;
      }
      client.isAlive = false;
      client.ping();
    });
  }, 30000);

  wss.on("close", () => clearInterval(heartbeat));

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const client = ws as AuthedWebSocket;
    client.connectionId = randomUUID();
    client.subscriptions = new Set();
    client.isAlive = true;
    const pendingMessages: RawData[] = [];
    let pendingMessageBytes = 0;
    let identityResolved = false;
    let identityValid = false;
    let processing = Promise.resolve();
    const authenticationTimeout = setTimeout(() => {
      if (identityResolved) return;
      identityResolved = true;
      pendingMessages.length = 0;
      pendingMessageBytes = 0;
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "error",
          code: "AUTHENTICATION_TIMEOUT",
          message: "No autenticado",
        }));
        client.close(1008, "Tiempo de autenticación agotado");
      }
    }, AUTH_RESOLUTION_TIMEOUT_MS);

    client.on("pong", () => {
      client.isAlive = true;
    });

    const processMessage = async (data: RawData) => {
      try {
        const msg = JSON.parse(data.toString());

        // Handle transport-level ping before auth checks
        if (msg.type === "ping") {
          // Also reset the WS-protocol liveness flag so the server heartbeat
          // doesn't race with the application-level keepalive and terminate
          // a connection that is actually alive.
          client.isAlive = true;
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: "pong" }));
          }
          // Update last_seen_at on ping (throttled to once per minute)
          if (client.userId) {
            throttleLastSeenUpdate(client.userId);
          }
          return;
        }

        switch (msg.type) {
          case "subscribe": {
            if (!msg.channel) break;
            const channelTopic = msg.channel as string;

            // Enforce access control for channel:N subscriptions
            const match = channelTopic.match(/^channel:(\d+)$/);
            if (match) {
              if (!client.userId) {
                client.send(JSON.stringify({ type: "error", message: "No autenticado" }));
                break;
              }
              const channelId = parseInt(match[1], 10);
              const [ch] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
              if (!ch || !(await canAccessChannel(ch, client.userId, client.userRole))) {
                client.send(JSON.stringify({ type: "error", message: "No tienes acceso a este canal" }));
                break;
              }
            }

            client.subscriptions.add(channelTopic);
            break;
          }

          case "unsubscribe":
            if (msg.channel) {
              client.subscriptions.delete(msg.channel);
            }
            break;

          case "typing:start":
            if (msg.channelId && client.userId) {
              // Verify the client is already subscribed (implies they passed the access check)
              if (client.subscriptions.has(`channel:${msg.channelId}`)) {
                broadcast(`channel:${msg.channelId}`, {
                  type: "typing:start",
                  data: { userId: client.userId, channelId: msg.channelId },
                });
              }
            }
            break;

          case "typing:stop":
            if (msg.channelId && client.userId) {
              if (client.subscriptions.has(`channel:${msg.channelId}`)) {
                broadcast(`channel:${msg.channelId}`, {
                  type: "typing:stop",
                  data: { userId: client.userId, channelId: msg.channelId },
                });
              }
            }
            break;

          case "dm_typing:start":
            if (msg.recipientId && client.userId) {
              broadcastToUser(msg.recipientId, {
                type: "dm_typing:start",
                data: { userId: client.userId },
              });
            }
            break;

          case "dm_typing:stop":
            if (msg.recipientId && client.userId) {
              broadcastToUser(msg.recipientId, {
                type: "dm_typing:stop",
                data: { userId: client.userId },
              });
            }
            break;

          case "ping":
            client.send(JSON.stringify({ type: "pong" }));
            break;

          case "watch:start":
          case "watch:add":
          case "watch:sync":
          case "watch:join":
          case "watch:leave":
          case "watch:control":
            await processWatchMessage(client, msg as Record<string, unknown>);
            break;

          case "voice:bind": {
            const channelId = Number(msg.channelId);
            if (!client.userId || !Number.isInteger(channelId)) break;
            const [channel] = await db.select().from(channelsTable).where(eq(channelsTable.id, channelId));
            if (!channel || channel.channelType !== "voice" ||
                !(await canAccessChannel(channel, client.userId, client.userRole))) {
              client.send(JSON.stringify({
                type: "error", code: "VOICE_ACCESS_DENIED",
                channelId, message: "Ya no tienes acceso a este canal de voz",
              }));
              break;
            }
            if (!hasVoiceMembership(channelId, client.userId)) {
              client.send(JSON.stringify({
                type: "error",
                code: "VOICE_MEMBERSHIP_REQUIRED",
                channelId,
                message: "Debes entrar al canal de voz antes de vincular la conexión",
              }));
              break;
            }
            const [user] = await db
              .select()
              .from(usersTable)
              .where(eq(usersTable.id, client.userId));
            const binding = bindVoiceConnection(
              channelId,
              client.userId,
              client.connectionId,
            );
            if (!binding.accepted) {
              client.send(JSON.stringify({
                type: "error",
                code: "VOICE_MEMBERSHIP_REQUIRED",
                channelId,
                message: "La entrada al canal de voz ya no está activa",
              }));
              break;
            }
            client.send(JSON.stringify({
              type: "voice:bound",
              data: {
                channelId,
                userIds: [...(voiceChannelMembersMap.get(channelId)?.entries() ?? [])]
                  .filter(([, connections]) => connections.size > 0)
                  .map(([userId]) => userId),
              },
            }));
            if (binding.newConnection) sendWatchStateToConnection(client, "voice", channelId);
            // A replacement connection must prompt peers to renegotiate even
            // when the old connection has not yet timed out.
            if (binding.newConnection && user) {
              broadcast(`channel:${channelId}`, {
                type: "voice:member_join",
                data: {
                  channelId,
                  member: {
                    userId: user.id,
                    username: user.username,
                    displayName: user.displayName,
                    avatarUrl: user.avatarUrl,
                    status: user.status,
                  },
                },
              });
            }
            break;
          }

          case "voice:unbind": {
            const channelId = Number(msg.channelId);
            if (
              client.userId
              && Number.isInteger(channelId)
              && unbindVoiceConnection(channelId, client.userId, client.connectionId)
            ) {
              broadcast(`channel:${channelId}`, {
                type: "voice:member_leave",
                data: { channelId, userId: client.userId, reason: "left" },
              });
            }
            break;
          }

          // ── WebRTC voice signaling (relayed point-to-point) ─────────────
          case "voice:offer":
            if (client.userId && msg.targetUserId && msg.sdp) {
              sendVoiceSignal(client, msg.targetUserId, {
                type: "voice:offer",
                data: {
                  fromUserId: client.userId,
                  fromConnectionId: client.connectionId,
                  sdp: msg.sdp,
                },
              });
            }
            break;

          case "voice:answer":
            if (client.userId && msg.targetUserId && msg.sdp) {
              sendVoiceSignal(client, msg.targetUserId, {
                type: "voice:answer",
                data: {
                  fromUserId: client.userId,
                  fromConnectionId: client.connectionId,
                  sdp: msg.sdp,
                },
              });
            }
            break;

          case "voice:ice-candidate":
            if (client.userId && msg.targetUserId && msg.candidate) {
              sendVoiceSignal(client, msg.targetUserId, {
                type: "voice:ice-candidate",
                data: {
                  fromUserId: client.userId,
                  fromConnectionId: client.connectionId,
                  candidate: msg.candidate,
                },
              });
            }
            break;

          // ── DM call signaling ────────────────────────────────────────────
          case "dm:call-invite":
            if (client.userId && msg.recipientId) {
              const previousRoute = dmCallRoutes.get(dmCallKey(client.userId, msg.recipientId));
              if (previousRoute) endDmWatchSession(previousRoute);
              const recipientConnection = findUserConnection(msg.recipientId);
              if (!recipientConnection) break;
              setDmCallRoute({
                callerUserId: client.userId,
                callerConnectionId: client.connectionId,
                recipientUserId: msg.recipientId,
                recipientConnectionId: recipientConnection.connectionId,
              }, DM_CALL_INVITE_TTL_MS);
              sendToConnection(recipientConnection.connectionId, {
                type: "dm:call-invite",
                data: {
                  callerId: client.userId,
                  callerConnectionId: client.connectionId,
                  callerName: msg.callerName ?? "Usuario",
                  callerAvatar: msg.callerAvatar ?? null,
                },
              });
            }
            break;

          case "dm:call-answer":
            if (client.userId && msg.callerId) {
              const sent = sendDmCallSignal(client, msg.callerId, {
                type: "dm:call-accepted",
                data: {
                  acceptorId: client.userId,
                  acceptorConnectionId: client.connectionId,
                },
              });
              if (sent) markDmCallRouteActive(client.userId, msg.callerId);
              if (sent) broadcastWatchState("dm", client.userId, msg.callerId);
            }
            break;

          case "dm:call-offer":
            if (client.userId && msg.targetUserId && msg.sdp) {
              sendDmCallSignal(client, msg.targetUserId, {
                type: "dm:call-offer",
                data: {
                  fromUserId: client.userId,
                  fromConnectionId: client.connectionId,
                  sdp: msg.sdp,
                },
              });
            }
            break;

          case "dm:call-sdp-answer":
            if (client.userId && msg.targetUserId && msg.sdp) {
              sendDmCallSignal(client, msg.targetUserId, {
                type: "dm:call-sdp-answer",
                data: {
                  fromUserId: client.userId,
                  fromConnectionId: client.connectionId,
                  sdp: msg.sdp,
                },
              });
            }
            break;

          case "dm:call-ice-candidate":
            if (client.userId && msg.targetUserId && msg.candidate) {
              sendDmCallSignal(client, msg.targetUserId, {
                type: "dm:call-ice-candidate",
                data: {
                  fromUserId: client.userId,
                  fromConnectionId: client.connectionId,
                  candidate: msg.candidate,
                },
              });
            }
            break;

          case "dm:call-reject":
            if (client.userId && msg.callerId) {
              const key = dmCallKey(client.userId, msg.callerId);
              const route = dmCallRoutes.get(key);
              if (route) endDmWatchSession(route);
              sendDmCallSignal(client, msg.callerId, {
                type: "dm:call-reject",
                data: { fromUserId: client.userId },
              });
              clearDmCallRoute(key);
            }
            break;

          case "dm:call-end":
            if (client.userId && msg.targetUserId) {
              const key = dmCallKey(client.userId, msg.targetUserId);
              const route = dmCallRoutes.get(key);
              if (route) endDmWatchSession(route);
              sendDmCallSignal(client, msg.targetUserId, {
                type: "dm:call-end",
                data: { fromUserId: client.userId },
              });
              clearDmCallRoute(key);
            }
            break;
        }
      } catch (err) {
        logger.warn({ err }, "Failed to parse WebSocket message");
      }
    };

    const enqueueMessage = (data: RawData) => {
      processing = processing
        .then(() => processMessage(data))
        .catch((err) => logger.warn({ err }, "Failed to process WebSocket message"));
    };

    client.on("message", (data) => {
      if (!identityResolved) {
        const messageBytes = rawDataByteLength(data);
        if (
          pendingMessages.length >= MAX_PENDING_AUTH_MESSAGES
          || pendingMessageBytes + messageBytes > MAX_PENDING_AUTH_BYTES
        ) {
          identityResolved = true;
          pendingMessages.length = 0;
          pendingMessageBytes = 0;
          clearTimeout(authenticationTimeout);
          client.send(JSON.stringify({
            type: "error",
            code: "AUTH_QUEUE_LIMIT",
            message: "No autenticado",
          }));
          client.close(1009, "Límite previo a autenticación excedido");
          return;
        }
        pendingMessages.push(data);
        pendingMessageBytes += messageBytes;
        return;
      }
      if (!identityValid) {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "error",
            code: "UNAUTHENTICATED",
            message: "No autenticado",
          }));
        }
        return;
      }
      enqueueMessage(data);
    });

    resolveWebSocketIdentity(req.headers.cookie).then((identity) => {
      if (identityResolved) return;
      identityResolved = true;
      clearTimeout(authenticationTimeout);
      if (!identity || client.readyState !== WebSocket.OPEN) {
        pendingMessages.length = 0;
        pendingMessageBytes = 0;
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "error",
            code: "UNAUTHENTICATED",
            message: "No autenticado",
          }));
          client.close(1008, "No autenticado");
        }
        return;
      }

      identityValid = true;
      client.userId = identity.userId;
      client.userRole = identity.userRole;
      client.send(JSON.stringify({
        type: "connected",
        connectionId: client.connectionId,
        userId: client.userId,
      }));
      logger.debug(
        { userId: client.userId, connectionId: client.connectionId },
        "WebSocket client authenticated",
      );

      // Presence: track connection count and set online on first connection
      const prevCount = userConnectionCounts.get(client.userId) ?? 0;
      userConnectionCounts.set(client.userId, prevCount + 1);
      if (prevCount === 0) {
        updateUserPresence(client.userId, "online");
      }

      const queuedMessages = pendingMessages.splice(0);
      pendingMessageBytes = 0;
      for (const data of queuedMessages) enqueueMessage(data);
    }).catch((err) => {
      if (identityResolved) return;
      identityResolved = true;
      clearTimeout(authenticationTimeout);
      pendingMessages.length = 0;
      pendingMessageBytes = 0;
      logger.warn({ err, connectionId: client.connectionId }, "WebSocket identity resolution failed");
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: "error",
          code: "UNAUTHENTICATED",
          message: "No autenticado",
        }));
        client.close(1011, "Error de autenticación");
      }
    });

    client.on("close", () => {
      clearTimeout(authenticationTimeout);
      pendingMessages.length = 0;
      pendingMessageBytes = 0;
      if (client.userId) {
        // Presence: decrement connection count and set offline when last connection drops
        const currentCount = userConnectionCounts.get(client.userId) ?? 1;
        if (currentCount <= 1) {
          userConnectionCounts.delete(client.userId);
          lastSeenThrottleMap.delete(client.userId);
          updateUserPresence(client.userId, "offline");
        } else {
          userConnectionCounts.set(client.userId, currentCount - 1);
        }

        const channels = getVoiceChannelsForConnection(
          client.userId,
          client.connectionId,
        );
        for (const channelId of channels) {
          if (unbindVoiceConnection(channelId, client.userId, client.connectionId)) {
            broadcast(`channel:${channelId}`, {
              type: "voice:member_leave",
              data: { channelId, userId: client.userId, reason: "connection_lost" },
            });
          }
          dropWatchSessionWhenVoiceEmpty(channelId);
        }

        for (const [key, route] of dmCallRoutes) {
          const isCaller = route.callerConnectionId === client.connectionId;
          const isRecipient = route.recipientConnectionId === client.connectionId;
          if (!isCaller && !isRecipient) continue;
          const otherConnectionId = isCaller
            ? route.recipientConnectionId
            : route.callerConnectionId;
          endDmWatchSession(route);
          sendToConnection(otherConnectionId, {
            type: "dm:call-end",
            data: { fromUserId: client.userId },
          });
          clearDmCallRoute(key);
        }
      }
      logger.debug(
        { userId: client.userId, connectionId: client.connectionId },
        "WebSocket client disconnected",
      );
    });

    client.on("error", (err) => {
      logger.warn({ err, userId: client.userId }, "WebSocket client error");
    });

  });

  logger.info("WebSocket server initialized at /ws");
}

function findUserConnection(userId: number): AuthedWebSocket | null {
  if (!wss) return null;
  for (const ws of wss.clients) {
    const client = ws as AuthedWebSocket;
    if (client.readyState === WebSocket.OPEN && client.userId === userId) {
      return client;
    }
  }
  return null;
}

function sendToConnection(connectionId: string, payload: object): boolean {
  if (!wss) return false;
  const data = JSON.stringify(payload);
  for (const ws of wss.clients) {
    const client = ws as AuthedWebSocket;
    if (
      client.readyState === WebSocket.OPEN
      && client.connectionId === connectionId
    ) {
      client.send(data);
      return true;
    }
  }
  return false;
}

function sendVoiceSignal(
  source: AuthedWebSocket,
  targetUserId: number,
  payload: object,
): boolean {
  if (!source.userId) return false;
  const target = getVoiceTargetConnection(
    source.userId,
    source.connectionId,
    targetUserId,
  );
  return target
    ? sendToConnection(target.connectionId, {
      ...payload,
      data: {
        ...(payload as { data: Record<string, unknown> }).data,
        channelId: target.channelId,
      },
    })
    : false;
}

function sendDmCallSignal(
  source: AuthedWebSocket,
  targetUserId: number,
  payload: object,
): boolean {
  if (!source.userId) return false;
  const route = dmCallRoutes.get(dmCallKey(source.userId, targetUserId));
  if (!route) return false;

  if (
    route.callerUserId === source.userId
    && route.callerConnectionId === source.connectionId
    && route.recipientUserId === targetUserId
  ) {
    return sendToConnection(route.recipientConnectionId, payload);
  }
  if (
    route.recipientUserId === source.userId
    && route.recipientConnectionId === source.connectionId
    && route.callerUserId === targetUserId
  ) {
    return sendToConnection(route.callerConnectionId, payload);
  }
  return false;
}

function findOpenConnection(
  connectionId: string,
  userId: number,
): AuthedWebSocket | null {
  if (!wss) return null;
  for (const ws of wss.clients) {
    const client = ws as AuthedWebSocket;
    if (
      client.readyState === WebSocket.OPEN
      && client.connectionId === connectionId
      && client.userId === userId
    ) {
      return client;
    }
  }
  return null;
}

export function emitSoundboardToCall(
  senderUserId: number,
  callType: "voice" | "dm",
  targetId: number,
  event: { type: "soundboard:play"; data: unknown },
): boolean {
  if (
    !wss
    || !Number.isInteger(senderUserId)
    || !Number.isInteger(targetId)
    || senderUserId <= 0
    || targetId <= 0
  ) {
    return false;
  }

  if (callType === "voice") {
    const memberConnections = voiceChannelMembersMap
      .get(targetId)
      ?.get(senderUserId);
    if (!memberConnections) return false;
    const senderIsConnected = [...memberConnections].some(
      (connectionId) => findOpenConnection(connectionId, senderUserId) !== null,
    );
    if (!senderIsConnected) return false;

    const data = JSON.stringify(event);
    const members = voiceChannelMembersMap.get(targetId);
    if (!members) return false;
    for (const [userId, connectionIds] of members) {
      if (userId === senderUserId) continue;
      for (const connectionId of connectionIds) {
        const recipient = findOpenConnection(connectionId, userId);
        if (recipient) recipient.send(data);
      }
    }
    return true;
  }

  if (callType === "dm" && senderUserId !== targetId) {
    const route = dmCallRoutes.get(dmCallKey(senderUserId, targetId));
    if (!route?.active) return false;

    let recipientConnectionId: string | null = null;
    let recipientUserId: number | null = null;
    if (
      route.callerUserId === senderUserId
      && route.recipientUserId === targetId
    ) {
      if (!findOpenConnection(route.callerConnectionId, senderUserId)) return false;
      recipientConnectionId = route.recipientConnectionId;
      recipientUserId = route.recipientUserId;
    } else if (
      route.recipientUserId === senderUserId
      && route.callerUserId === targetId
    ) {
      if (!findOpenConnection(route.recipientConnectionId, senderUserId)) return false;
      recipientConnectionId = route.callerConnectionId;
      recipientUserId = route.callerUserId;
    }
    if (!recipientConnectionId || recipientUserId === null) return false;
    const recipient = findOpenConnection(recipientConnectionId, recipientUserId);
    if (!recipient) return false;
    recipient.send(JSON.stringify(event));
    return true;
  }

  return false;
}

export function broadcast(channel: string, payload: object): void {
  if (!wss) return;
  const data = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    const client = ws as AuthedWebSocket;
    if (client.readyState === WebSocket.OPEN && client.subscriptions.has(channel)) {
      client.send(data);
    }
  });
}

export function broadcastAll(payload: object): void {
  if (!wss) return;
  const data = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

/** Send a payload to every connected WebSocket client authenticated as `targetUserId`. */
export function broadcastToUser(targetUserId: number, payload: object): void {
  if (!wss) return;
  const data = JSON.stringify(payload);
  wss.clients.forEach((ws) => {
    const client = ws as AuthedWebSocket;
    if (client.readyState === WebSocket.OPEN && client.userId === targetUserId) {
      client.send(data);
    }
  });
}

/**
 * Send a payload to every connected member of a server.
 * Queries server_members to get the list of userIds, then uses broadcastToUser for each.
 * This avoids leaking restricted channel info: the event only says "channels changed",
 * and each client re-fetches the list (which the server already filters by permissions).
 */
export async function broadcastToServerMembers(serverId: number, payload: object): Promise<void> {
  try {
    const members = await db
      .select({ userId: serverMembersTable.userId })
      .from(serverMembersTable)
      .where(eq(serverMembersTable.serverId, serverId));
    for (const member of members) {
      broadcastToUser(member.userId, payload);
    }
  } catch (err) {
    logger.error({ err, serverId }, "Failed to broadcast to server members");
  }
}

/**
 * Evict all voice members from a channel that is being deleted.
 * Sends voice:member_leave with reason "channel_deleted" to each member's connections,
 * clears the channel from the in-memory voice map, and ends any watch session.
 */
export function evictVoiceChannel(channelId: number): void {
  const members = voiceChannelMembersMap.get(channelId);
  if (!members) return;

  // Collect all user/connection pairs before mutating the map
  const evictions: Array<{ userId: number; connectionIds: Set<string> }> = [];
  for (const [userId, connectionIds] of members) {
    if (connectionIds.size > 0) {
      evictions.push({ userId, connectionIds: new Set(connectionIds) });
    }
  }

  // Clear the entire channel from the voice map
  voiceChannelMembersMap.delete(channelId);

  // Clear any pending bind reservations for this channel
  for (const [key, timer] of voiceBindReservationTimers) {
    if (key.startsWith(`${channelId}:`)) {
      clearTimeout(timer);
      voiceBindReservationTimers.delete(key);
    }
  }

  // End any active watch session for this voice channel
  watchSessions.end("voice", channelId);

  // Notify each evicted member on all their connections
  if (!wss) return;
  const event = JSON.stringify({
    type: "voice:member_leave",
    data: { channelId, userId: null, reason: "channel_deleted" },
  });
  for (const { userId, connectionIds } of evictions) {
    for (const connectionId of connectionIds) {
      const client = findOpenConnection(connectionId, userId);
      if (client) {
        client.send(event);
      }
    }
  }
}

function extractSessionId(cookieHeader: string): string | null {
  const encodedValue = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect.sid="))
    ?.slice("connect.sid=".length);
  if (!encodedValue) return null;
  try {
    const signedValue = decodeURIComponent(encodedValue);
    const sessionId = cookieParser.signedCookie(signedValue, SESSION_SECRET);
    return typeof sessionId === "string" ? sessionId : null;
  } catch {
    return null;
  }
}

function resolveWebSocketIdentity(
  cookieHeader: string | undefined,
): Promise<{ userId: number; userRole?: string } | null> {
  return new Promise((resolve, reject) => {
    if (!cookieHeader) {
      resolve(null);
      return;
    }
    const sessionId = extractSessionId(cookieHeader);
    const sessionStore = (globalThis as any).__sessionStore;
    if (!sessionId || !sessionStore) {
      resolve(null);
      return;
    }
    sessionStore.get(
      sessionId,
      (err: Error | null, session: SessionData | null) => {
        if (err) {
          reject(err);
          return;
        }
        if (!session?.userId) {
          resolve(null);
          return;
        }
        resolve({
          userId: session.userId,
          userRole: (session as any).userRole as string | undefined,
        });
      },
    );
  });
}

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}
