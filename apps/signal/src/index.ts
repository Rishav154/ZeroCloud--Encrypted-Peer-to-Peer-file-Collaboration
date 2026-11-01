import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import { Pool } from "pg";
import { WebSocket, WebSocketServer } from "ws";
import {
  parseClientMessage,
  type ServerSignalMessage,
} from "@zerocloud/shared";
import { config } from "./config.js";

type SocketRoomState = { roomId: string | null; peerId: string | null };

const app = express();
const pool = new Pool({ connectionString: config.DATABASE_URL });
const server = createServer(app);
const sockets = new WebSocketServer({ noServer: true });
const rooms = new Map<string, Map<string, WebSocket>>();
const socketRoomState = new Map<WebSocket, SocketRoomState>();
const alive = new WeakMap<WebSocket, boolean>();
const startedAt = Date.now();

function logEvent(
  roomId: string | null,
  peerId: string | null,
  event: string,
): void {
  console.info(
    `[room=${roomId ?? "-"}] [peer=${peerId?.slice(0, 8) ?? "-"}] ${event}`,
  );
}

function sendMessage(socket: WebSocket, message: ServerSignalMessage): void {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, code: string, message: string): void {
  sendMessage(socket, { type: "error", code, message });
}

function broadcast(
  room: Map<string, WebSocket>,
  message: ServerSignalMessage,
  except?: WebSocket,
): void {
  for (const socket of room.values()) {
    if (socket !== except) sendMessage(socket, message);
  }
}

function removePeer(socket: WebSocket, event: "leave" | "disconnect"): void {
  const state = socketRoomState.get(socket);
  if (!state?.roomId || !state.peerId) return;

  const { roomId, peerId } = state;
  const room = rooms.get(roomId);
  room?.delete(peerId);
  if (room) {
    broadcast(room, { type: "peer-left", peerId });
    if (room.size === 0) rooms.delete(roomId);
  }

  state.roomId = null;
  state.peerId = null;
  logEvent(roomId, peerId, event);
}

app.use(cors({ origin: config.ALLOWED_ORIGIN }));
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
  const state: SocketRoomState = { roomId: null, peerId: null };
  socketRoomState.set(socket, state);
  alive.set(socket, true);
  logEvent(null, null, "connected");

  socket.on("pong", () => alive.set(socket, true));
  socket.on("message", (raw) => {
    const parsed = parseClientMessage(raw.toString());
    if (!parsed.success) {
      logEvent(state.roomId, state.peerId, "invalid-message");
      sendError(socket, "INVALID_MESSAGE", parsed.error);
      return;
    }

    const message = parsed.data;
    if (message.type === "ping") {
      sendMessage(socket, {
        type: "pong",
        ts: message.ts,
        serverTime: Date.now(),
      });
      return;
    }

    if (message.type === "join") {
      if (state.roomId && state.peerId) {
        if (
          state.roomId === message.roomId &&
          state.peerId === message.peerId
        ) {
          const peers = Array.from(
            rooms.get(state.roomId)?.keys() ?? [],
          ).filter((peerId) => peerId !== state.peerId);
          sendMessage(socket, { type: "joined", peerId: state.peerId, peers });
        } else {
          logEvent(state.roomId, state.peerId, "join-rejected-already-in-room");
          sendError(socket, "ALREADY_IN_ROOM", "Leave the current room first");
        }
        return;
      }

      let room = rooms.get(message.roomId);
      if (room?.has(message.peerId)) {
        logEvent(
          message.roomId,
          message.peerId,
          "join-rejected-peer-id-in-use",
        );
        sendError(
          socket,
          "PEER_ID_IN_USE",
          "This peer ID is already in the room",
        );
        return;
      }
      if (room && room.size >= 8) {
        logEvent(message.roomId, message.peerId, "join-rejected-room-full");
        sendError(socket, "ROOM_FULL", "This room already has 8 peers");
        return;
      }

      if (!room) {
        room = new Map();
        rooms.set(message.roomId, room);
      }
      const peers = Array.from(room.keys());
      room.set(message.peerId, socket);
      state.roomId = message.roomId;
      state.peerId = message.peerId;

      sendMessage(socket, { type: "joined", peerId: message.peerId, peers });
      broadcast(room, { type: "peer-joined", peerId: message.peerId }, socket);
      logEvent(message.roomId, message.peerId, "joined");
      return;
    }

    if (message.type === "leave") {
      removePeer(socket, "leave");
      return;
    }

    if (!state.roomId || !state.peerId) {
      sendError(socket, "NOT_IN_ROOM", "Join a room before sending signals");
      return;
    }
    const target = rooms.get(state.roomId)?.get(message.to);
    if (!target) {
      logEvent(state.roomId, state.peerId, "signal-target-missing");
      sendError(
        socket,
        "PEER_NOT_FOUND",
        "The target peer is not in this room",
      );
      return;
    }

    // The payload is validated as protocol data and forwarded without logging or storing it.
    sendMessage(target, {
      type: "signal",
      from: state.peerId,
      data: message.data,
    });
    logEvent(state.roomId, state.peerId, `signal-relayed-${message.data.kind}`);
  });

  socket.on("close", () => {
    const wasInRoom = Boolean(state.roomId && state.peerId);
    removePeer(socket, "disconnect");
    socketRoomState.delete(socket);
    if (!wasInRoom) logEvent(null, null, "disconnected");
  });
  socket.on("error", () =>
    logEvent(state.roomId, state.peerId, "socket-error"),
  );
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
