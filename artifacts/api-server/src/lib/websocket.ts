import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { Server as HttpServer } from "http";
import type { SessionData } from "express-session";
import { logger } from "./logger";

interface AuthedWebSocket extends WebSocket {
  userId?: number;
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
              logger.debug({ userId: client.userId }, "WebSocket client authenticated");
            }
          });
        }
      }
    }

    client.on("pong", () => {
      client.isAlive = true;
    });

    client.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        switch (msg.type) {
          case "subscribe":
            if (msg.channel) {
              client.subscriptions.add(msg.channel);
            }
            break;

          case "unsubscribe":
            if (msg.channel) {
              client.subscriptions.delete(msg.channel);
            }
            break;

          case "typing:start":
            if (msg.channelId && client.userId) {
              broadcast(`channel:${msg.channelId}`, {
                type: "typing:start",
                data: { userId: client.userId, channelId: msg.channelId },
              });
            }
            break;

          case "typing:stop":
            if (msg.channelId && client.userId) {
              broadcast(`channel:${msg.channelId}`, {
                type: "typing:stop",
                data: { userId: client.userId, channelId: msg.channelId },
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

function extractSessionId(cookieHeader: string): string | null {
  const match = cookieHeader.match(/connect\.sid=s%3A([^.;]+)/);
  if (match) return decodeURIComponent(match[1]);
  return null;
}
