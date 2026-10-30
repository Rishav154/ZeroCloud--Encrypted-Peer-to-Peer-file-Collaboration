import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { WebSocketServer } from "ws";
import { parseMessage } from "@zerocloud/shared";
import { config } from "./config.js";

const app = express();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const server = createServer(app);
const sockets = new WebSocketServer({ noServer: true });
const startedAt = Date.now();

app.use(cors({ origin: config.ALLOWED_ORIGIN }));
app.get("/health", async (_request, response) => {
  let db: "up" | "down" = "up";
  try {
    await pool.query("SELECT 1");
  } catch {
    db = "down";
  }
  response
    .status(200)
    .json({
      status: "ok",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      db,
    });
});

server.on("upgrade", (request, socket, head) => {
  if (
    request.url !== "/ws" ||
    request.headers.origin !== config.ALLOWED_ORIGIN
  ) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  sockets.handleUpgrade(request, socket, head, (webSocket) => {
    sockets.emit("connection", webSocket, request);
  });
});

sockets.on("connection", (webSocket) => {
  const connectionId = randomUUID().slice(0, 8);
  console.info(`[${connectionId}] connected`);
  webSocket.on("message", (raw) => {
    const parsed = parseMessage(raw.toString());
    if (!parsed.success) {
      webSocket.send(JSON.stringify({ type: "error", message: parsed.error }));
      return;
    }
    if (parsed.data.type === "ping") {
      webSocket.send(
        JSON.stringify({
          type: "pong",
          ts: parsed.data.ts,
          serverTime: Date.now(),
        }),
      );
    }
  });
  webSocket.on("close", () => console.info(`[${connectionId}] disconnected`));
  webSocket.on("error", (error) =>
    console.error(`[${connectionId}] websocket error`, error),
  );
});

server.listen(config.PORT, () =>
  console.info(`Signal server listening on ${config.PORT}`),
);

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const webSocket of sockets.clients)
    webSocket.close(1001, "Server shutting down");
  sockets.close(() => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
