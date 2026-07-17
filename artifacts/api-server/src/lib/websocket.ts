import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server as HttpServer } from "http";
import type { SessionData } from "express-session";
import { eq } from "drizzle-orm";
import { db, channelsTable } from "@workspace/db";
import { canAccessChannel } from "./permissions";
import { logger } from "./logger";

interface AuthedWebSocket extends WebSocket {
  userId?: number;
  userRole?: string;
  subscriptions: Set<string>;
  isAlive: boolean;
}

let wss: WebSocketServer | null = null;

// ── In-memory voice channel state ──────────────────────────────────────────
// channelId → Set<userId>
const voiceChannelMembersMap = new Map<number, Set<number>>();

export function joinVoiceChannel(channelId: number, userId: number): void {
  if (!voiceChannelMembersMap.has(channelId)) {
    voiceChannelMembersMap.set(channelId, new Set());
  }
  voiceChannelMembersMap.get(channelId)!.add(userId);
}

export function leaveVoiceChannel(channelId: number, userId: number): void {
  const members = voiceChannelMembersMap.get(channelId);
  if (members) {
    members.delete(userId);
    if (members.size === 0) voiceChannelMembersMap.delete(channelId);
  }
}

export function getVoiceChannelMembers(channelId: number): Set<number> {
  return voiceChannelMembersMap.get(channelId) ?? new Set();
}

export function getAllVoiceChannelsForUser(userId: number): number[] {
  const result: number[] = [];
  voiceChannelMembersMap.forEach((members, channelId) => {
    if (members.has(userId)) result.push(channelId);
  });
  return result;
}

export function initWebSocket(server: HttpServer): void {
  wss = new WebSocketServer({ server, path: "/ws" });

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
    client.subscriptions = new Set();
    client.isAlive = true;

    // Parse session from cookie
    const cookieHeader = req.headers.cookie;
    if (cookieHeader) {
      // Session ID extracted from signed cookie by express-session
      // We attach the sessionStore from app.ts
      const sessionStore = (globalThis as any).__sessionStore;
      if (sessionStore) {
        const sessionId = extractSessionId(cookieHeader);
        if (sessionId) {
          sessionStore.get(sessionId, (err: Error | null, session: SessionData | null) => {
            if (!err && session?.userId) {
              client.userId = session.userId;
              client.userRole = (session as any).userRole as string | undefined;
              logger.debug({ userId: client.userId }, "WebSocket client authenticated");
            }
          });
        }
      }
    }

    client.on("pong", () => {
      client.isAlive = true;
    });

    client.on("message", async (data) => {
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

          // ── WebRTC voice signaling (relayed point-to-point) ─────────────
          case "voice:offer":
            if (client.userId && msg.targetUserId && msg.sdp) {
              broadcastToUser(msg.targetUserId, {
                type: "voice:offer",
                data: { fromUserId: client.userId, sdp: msg.sdp },
              });
            }
            break;

          case "voice:answer":
            if (client.userId && msg.targetUserId && msg.sdp) {
              broadcastToUser(msg.targetUserId, {
                type: "voice:answer",
                data: { fromUserId: client.userId, sdp: msg.sdp },
              });
            }
            break;

          case "voice:ice-candidate":
            if (client.userId && msg.targetUserId && msg.candidate) {
              broadcastToUser(msg.targetUserId, {
                type: "voice:ice-candidate",
                data: { fromUserId: client.userId, candidate: msg.candidate },
              });
            }
            break;

          // ── DM call signaling ────────────────────────────────────────────
          case "dm:call-invite":
            if (client.userId && msg.recipientId) {
              broadcastToUser(msg.recipientId, {
                type: "dm:call-invite",
                data: {
                  callerId: client.userId,
                  callerName: msg.callerName ?? "Usuario",
                  callerAvatar: msg.callerAvatar ?? null,
                },
              });
            }
            break;

          case "dm:call-answer":
            if (client.userId && msg.callerId) {
              broadcastToUser(msg.callerId, {
                type: "dm:call-accepted",
                data: { acceptorId: client.userId },
              });
            }
            break;

          case "dm:call-offer":
            if (client.userId && msg.targetUserId && msg.sdp) {
              broadcastToUser(msg.targetUserId, {
                type: "dm:call-offer",
                data: { fromUserId: client.userId, sdp: msg.sdp },
              });
            }
            break;

          case "dm:call-sdp-answer":
            if (client.userId && msg.targetUserId && msg.sdp) {
              broadcastToUser(msg.targetUserId, {
                type: "dm:call-sdp-answer",
                data: { fromUserId: client.userId, sdp: msg.sdp },
              });
            }
            break;

          case "dm:call-ice-candidate":
            if (client.userId && msg.targetUserId && msg.candidate) {
              broadcastToUser(msg.targetUserId, {
                type: "dm:call-ice-candidate",
                data: { fromUserId: client.userId, candidate: msg.candidate },
              });
            }
            break;

          case "dm:call-reject":
            if (client.userId && msg.callerId) {
              broadcastToUser(msg.callerId, {
                type: "dm:call-reject",
                data: { fromUserId: client.userId },
              });
            }
            break;

          case "dm:call-end":
            if (client.userId && msg.targetUserId) {
              broadcastToUser(msg.targetUserId, {
                type: "dm:call-end",
                data: { fromUserId: client.userId },
              });
            }
            break;
        }
      } catch (err) {
        logger.warn({ err }, "Failed to parse WebSocket message");
      }
    });

    client.on("close", () => {
      // Auto-leave voice only when this is the user's LAST active connection.
      // Multiple WS connections exist per user (use-webrtc + use-chat-websocket),
      // so closing one (e.g. channelId change in chat hook) must not evict voice.
      if (client.userId) {
        const hasOtherConnections = Array.from(wss!.clients).some((c) => {
          const other = c as AuthedWebSocket;
          return (
            other !== client &&
            other.readyState === WebSocket.OPEN &&
            other.userId === client.userId
          );
        });
        if (!hasOtherConnections) {
          const channels = getAllVoiceChannelsForUser(client.userId);
          for (const channelId of channels) {
            leaveVoiceChannel(channelId, client.userId);
            broadcast(`channel:${channelId}`, {
              type: "voice:member_leave",
              data: { channelId, userId: client.userId },
            });
          }
        }
      }
      logger.debug({ userId: client.userId }, "WebSocket client disconnected");
    });

    client.on("error", (err) => {
      logger.warn({ err, userId: client.userId }, "WebSocket client error");
    });

    // Send welcome message
    client.send(JSON.stringify({ type: "connected" }));
  });

  logger.info("WebSocket server initialized at /ws");
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
  const match = cookieHeader.match(/connect\.sid=s%3A([^.;]+)/);
  if (match) return decodeURIComponent(match[1]);
  return null;
}
