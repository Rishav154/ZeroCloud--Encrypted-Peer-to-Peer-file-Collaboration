import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createApiRouter } from "./api.js";
import { config } from "./config.js";
import { ConnectionLimits } from "./connectionLimits.js";
import { createDatabasePool } from "./db/pool.js";
import { migrateDatabase } from "./db/migrate.js";
import { DatabaseHealth, waitForPool } from "./db/readiness.js";
import { createHealthHandler } from "./health.js";
import { IceServerService } from "./iceServers.js";
import { httpLogger, logger } from "./logging.js";
import { WorkspaceHub } from "./workspaceHub.js";
import { buildInfo } from "./build-info.generated.js";

async function start(): Promise<void> {
  const startupPool = createDatabasePool(config.DIRECT_DATABASE_URL, {
    ...config,
    DB_POOL_MAX: 1,
    DB_CONNECTION_TIMEOUT_MS: Math.min(config.DB_CONNECTION_TIMEOUT_MS, 3000),
  });
  try {
    await waitForPool(startupPool);
  } finally {
    await startupPool.end();
  }

  const migrationPool = createDatabasePool(config.DIRECT_DATABASE_URL, {
    ...config,
    DB_POOL_MAX: 1,
  });
  try {
    const applied = await migrateDatabase(migrationPool);
    logger.info({ migrations: applied.length }, "database migrations complete");
  } finally {
    await migrationPool.end();
  }

  const pool = createDatabasePool(config.DATABASE_URL, config);
  const databaseHealth = new DatabaseHealth(() => pool.query("SELECT 1"));
  const iceServerService = new IceServerService(config);
  const connectionLimits = new ConnectionLimits(20, 10);
  const workspaceHub = new WorkspaceHub(pool, config.JWT_SECRET, connectionLimits);
  const app = express();
  const server = createServer(app);
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const alive = new WeakMap<WebSocket, boolean>();
  const ipBySocket = new WeakMap<WebSocket, string>();
  const startedAt = Date.now();

  app.use(httpLogger);
  app.use(cors({ origin: config.ALLOWED_ORIGIN }));
  app.use(helmet());
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", createApiRouter(pool, config, workspaceHub, iceServerService));
  app.get("/health", createHealthHandler(databaseHealth, {
    BUILD_SHA: buildInfo.sha,
    BUILD_TIME: buildInfo.time,
  }, startedAt));

  const requestErrorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    void _next;
    const status =
      typeof error === "object" && error !== null && "status" in error &&
      typeof error.status === "number" && error.status >= 400 && error.status < 500
        ? error.status
        : 500;
    const requestId = response.getHeader("x-request-id");
    if (status >= 500) logger.error({ err: error, requestId }, "request failed");
    response.status(status).json({
      error: {
        code: status === 400 ? "INVALID_REQUEST" : "INTERNAL_ERROR",
        message: status === 400 ? "Request body is invalid" : "The request could not be completed",
      },
    });
  };
  app.use(requestErrorHandler);

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws" || request.headers.origin !== config.ALLOWED_ORIGIN) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const forwardedFor = request.headers["x-forwarded-for"];
    const ip = typeof forwardedFor === "string"
      ? forwardedFor.split(",")[0]?.trim() || request.socket.remoteAddress || "unknown"
      : request.socket.remoteAddress || "unknown";
    sockets.handleUpgrade(request, socket, head, (webSocket) => {
      ipBySocket.set(webSocket, ip);
      sockets.emit("connection", webSocket, request);
    });
  });

  sockets.on("connection", (socket) => {
    const ip = ipBySocket.get(socket) ?? "unknown";
    if (!connectionLimits.acquireIp(ip)) {
      socket.close(4429, "Per-IP connection limit reached");
      return;
    }
    alive.set(socket, true);
    socket.on("pong", () => alive.set(socket, true));
    socket.on("close", () => connectionLimits.releaseIp(ip));
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

  server.listen(config.PORT, () => logger.info({ port: config.PORT }, "signal server listening"));

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(heartbeat);
    for (const socket of sockets.clients) socket.close(1001, "Server shutting down");
    sockets.close(() => {
      server.close(() => {
        void pool.end().finally(() => process.exit(0));
      });
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void start().catch((error: unknown) => {
  logger.fatal({ err: error }, "signal server startup failed");
  process.exitCode = 1;
});
