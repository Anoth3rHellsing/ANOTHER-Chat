import http from "http";
import app, { ensureSessionTable } from "./app";
import { logger } from "./lib/logger";
import { initWebSocket } from "./lib/websocket";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function start() {
  // Create the sessions table before accepting connections so the session
  // store never tries to load the missing bundled table.sql file.
  await ensureSessionTable();

  const server = http.createServer(app);

  initWebSocket(server);

  server.listen(port, () => {
    logger.info({ port }, "Server listening");
  });

  server.on("error", (err) => {
    logger.error({ err }, "Server error");
    process.exit(1);
  });
}

start().catch((err) => {
  logger.error({ err }, "Failed to start server");
  process.exit(1);
});
