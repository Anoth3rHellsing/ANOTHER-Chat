import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { IncomingMessage } from "http";
import type { Server as HttpServer } from "http";
import type { SessionData } from "express-session";
import { eq } from "drizzle-orm";
import { db, channelsTable, usersTable } from "@workspace/db";
import { canAccessChannel } from "./permissions";
import { logger } from "./logger";
import { randomUUID } from "crypto";
import cookieParser from "cookie-parser";
import { SESSION_SECRET } from "./session-config";

const MAX_PENDING_AUTH_MESSAGES = 100;
const MAX_PENDING_AUTH_BYTES = 1_000_000;
const AUTH_RESOLUTION_TIMEOUT_MS = 5_000;
const VOICE_BIND_RESERVATION_MS = 10_000;
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
  if (members.size === 0) voiceChannelMembersMap.delete(channelId);
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
): { accepted: boolean; firstConnection: boolean } {
  const connections = voiceChannelMembersMap.get(channelId)?.get(userId);
  if (!connections) return { accepted: false, firstConnection: false };
  const firstConnection = connections.size === 0;
  connections.add(connectionId);
  clearVoiceBindReservation(channelId, userId);
  return { accepted: true, firstConnection };
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
  if (members.size === 0) voiceChannelMembersMap.delete(channelId);
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
    expiryTimer: setTimeout(() => clearDmCallRoute(key), ttlMs),
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

          case "voice:bind": {
            const channelId = Number(msg.channelId);
            if (!client.userId || !Number.isInteger(channelId)) break;
            if (!hasVoiceMembership(channelId, client.userId)) {
              client.send(JSON.stringify({
                type: "error",
                code: "VOICE_MEMBERSHIP_REQUIRED",
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
            if (binding.firstConnection && user) {
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
                data: { channelId, userId: client.userId },
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
              sendDmCallSignal(client, msg.callerId, {
                type: "dm:call-reject",
                data: { fromUserId: client.userId },
              });
              clearDmCallRoute(dmCallKey(client.userId, msg.callerId));
            }
            break;

          case "dm:call-end":
            if (client.userId && msg.targetUserId) {
              sendDmCallSignal(client, msg.targetUserId, {
                type: "dm:call-end",
                data: { fromUserId: client.userId },
              });
              clearDmCallRoute(dmCallKey(client.userId, msg.targetUserId));
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
        const channels = getVoiceChannelsForConnection(
          client.userId,
          client.connectionId,
        );
        for (const channelId of channels) {
          if (unbindVoiceConnection(channelId, client.userId, client.connectionId)) {
            broadcast(`channel:${channelId}`, {
              type: "voice:member_leave",
              data: { channelId, userId: client.userId },
            });
          }
        }

        for (const [key, route] of dmCallRoutes) {
          const isCaller = route.callerConnectionId === client.connectionId;
          const isRecipient = route.recipientConnectionId === client.connectionId;
          if (!isCaller && !isRecipient) continue;
          const otherConnectionId = isCaller
            ? route.recipientConnectionId
            : route.callerConnectionId;
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
