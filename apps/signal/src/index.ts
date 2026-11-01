import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { createServer } from "node:http";
import { Pool } from "pg";
import { WebSocket, WebSocketServer } from "ws";
import { createApiRouter } from "./api.js";
import { config } from "./config.js";
import { WorkspaceHub } from "./workspaceHub.js";

const app = express();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const server = createServer(app);
const sockets = new WebSocketServer({ noServer: true });
const workspaceHub = new WorkspaceHub(pool, config.JWT_SECRET);
const alive = new WeakMap<WebSocket, boolean>();
const startedAt = Date.now();

app.use(cors({ origin: config.ALLOWED_ORIGIN }));
app.use(helmet());
app.use(express.json({ limit: "64kb" }));
app.use("/api", createApiRouter(pool, config, workspaceHub));
app.get("/health", async (_request, response) => {
  let db: "up" | "down" = "up";
  try {
    await pool.query("SELECT 1");
  } catch {
    db = "down";
  }
  response.status(200).json({
    status: "ok",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    db,
  });
});

const requestErrorHandler: ErrorRequestHandler = (
  error,
  _request,
  response,
  _next,
) => {
  void _next;
  const status =
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number" &&
    error.status >= 400 &&
    error.status < 500
      ? error.status
      : 500;
  response.status(status).json({
    error: {
      code: status === 400 ? "INVALID_REQUEST" : "INTERNAL_ERROR",
      message:
        status === 400
          ? "Request body is invalid"
          : "The request could not be completed",
    },
  });
};
app.use(requestErrorHandler);

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

sockets.on("connection", (socket) => {
  alive.set(socket, true);
  socket.on("pong", () => alive.set(socket, true));
  workspaceHub.accept(socket);
});

const heartbeat = setInterval(() => {
  for (const socket of sockets.clients) {
    if (socket.readyState !== WebSocket.OPEN) continue;
    if (alive.get(socket) === false) {
      socket.terminate();
      continue;
    }
    alive.set(socket, false);
    socket.ping();
  }
}, 30_000);
heartbeat.unref();

server.listen(config.PORT, () =>
  console.info(`Signal server listening on ${config.PORT}`),
);

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  for (const socket of sockets.clients)
    socket.close(1001, "Server shutting down");
  sockets.close(() => {
    server.close(() => {
      void pool.end().finally(() => process.exit(0));
    });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
