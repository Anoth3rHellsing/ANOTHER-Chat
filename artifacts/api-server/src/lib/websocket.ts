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
        }
      } catch (err) {
        logger.warn({ err }, "Failed to parse WebSocket message");
      }
    });

    client.on("close", () => {
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
