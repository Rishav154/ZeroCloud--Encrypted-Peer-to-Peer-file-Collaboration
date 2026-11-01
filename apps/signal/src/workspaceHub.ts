import {
  parseClientMessage,
  type PeerDirectoryEntry,
  type ServerSignalMessage,
  type WorkspaceMemberDirectory,
  type WorkspaceRole,
} from "@zerocloud/shared";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { verifySessionToken } from "./auth/session.js";

type MemberRecord = {
  user_id: string;
  display_name: string;
  role: WorkspaceRole;
  fingerprint: string;
};

type SocketState = {
  connectionId: string;
  socket: WebSocket;
  userId: string | null;
  workspaceId: string | null;
  peer: PeerDirectoryEntry | null;
  authTimer: ReturnType<typeof setTimeout>;
  queue: Promise<void>;
};

export class WorkspaceHub {
  private readonly rooms = new Map<string, Map<string, SocketState>>();

  constructor(
    private readonly pool: Pool,
    private readonly jwtSecret: string,
  ) {}

  accept(socket: WebSocket): void {
    const state: SocketState = {
      connectionId: randomUUID().slice(0, 8),
      socket,
      userId: null,
      workspaceId: null,
      peer: null,
      authTimer: setTimeout(() => {
        this.sendError(state, "AUTH_TIMEOUT", "Authenticate within 5 seconds");
        socket.close(4401, "Authentication timeout");
      }, 5000),
      queue: Promise.resolve(),
    };
    state.authTimer.unref();
    this.log(null, null, `connected:${state.connectionId}`);
    socket.on("message", (raw) => {
      state.queue = state.queue
        .then(() => this.handleMessage(state, raw.toString()))
        .catch(() => {
          this.sendError(
            state,
            "INTERNAL_ERROR",
            "Message could not be handled",
          );
        });
    });
    socket.on("close", () => {
      clearTimeout(state.authTimer);
      const wasJoined = Boolean(state.workspaceId && state.peer);
      this.removePeer(state, `disconnect:${state.connectionId}`);
      if (!wasJoined)
        this.log(null, null, `disconnected:${state.connectionId}`);
    });
    socket.on("error", () =>
      this.log(state.workspaceId, state.peer?.peerId ?? null, "socket-error"),
    );
  }

  memberAdded(workspaceId: string, member: WorkspaceMemberDirectory): void {
    this.broadcast(workspaceId, { type: "member-added", member });
  }

  roleChanged(
    workspaceId: string,
    userId: string,
    role: "editor" | "viewer",
  ): void {
    const room = this.rooms.get(workspaceId);
    for (const state of room?.values() ?? []) {
      if (state.peer?.userId === userId) state.peer = { ...state.peer, role };
    }
    this.broadcast(workspaceId, { type: "role-changed", userId, role });
  }

  keyRotated(workspaceId: string, version: number, excludeUserId?: string): void {
    for (const state of this.rooms.get(workspaceId)?.values() ?? []) {
      if (excludeUserId && state.userId === excludeUserId) continue;
      this.send(state.socket, { type: "key-rotated", workspaceId, version });
    }
  }

  rotationNeeded(workspaceId: string, ownerUserId: string): void {
    for (const state of this.rooms.get(workspaceId)?.values() ?? []) {
      if (state.userId !== ownerUserId) continue;
      this.send(state.socket, { type: "rotation-needed", workspaceId });
    }
  }

  removeMember(workspaceId: string, userId: string): void {
    const room = this.rooms.get(workspaceId);
    if (!room) return;
    const removed = Array.from(room.values()).filter(
      (state) => state.peer?.userId === userId,
    );
    for (const state of room.values()) {
      if (state.peer?.userId === userId) continue;
      this.send(state.socket, { type: "member-removed", userId });
    }
    for (const state of removed) {
      this.send(state.socket, {
        type: "kicked",
        workspaceId,
        message: "Your workspace access was removed",
      });
      this.removePeer(state, "member-removed");
      state.socket.close(4403, "Removed from workspace");
    }
  }

  private async handleMessage(state: SocketState, raw: string): Promise<void> {
    const parsed = parseClientMessage(raw);
    if (!parsed.success) {
      this.log(state.workspaceId, state.peer?.peerId ?? null, "invalid-message");
      this.sendError(state, "INVALID_MESSAGE", parsed.error);
      return;
    }
    const message = parsed.data;
    if (message.type === "auth") {
      if (state.userId) {
        this.sendError(
          state,
          "ALREADY_AUTHENTICATED",
          "Connection is already authenticated",
        );
        state.socket.close(4401, "Duplicate authentication");
        return;
      }
      let userId: string;
      let expiresAt: number;
      try {
        const session = await verifySessionToken(message.token, this.jwtSecret);
        userId = session.userId;
        expiresAt = session.expiresAt;
      } catch {
        this.sendError(state, "UNAUTHORIZED", "Invalid or expired session");
        state.socket.close(4401, "Invalid session");
        return;
      }
      const exists = await this.pool.query(
        "SELECT 1 FROM users WHERE id = $1",
        [userId],
      );
      if (!exists.rowCount) {
        this.sendError(state, "UNAUTHORIZED", "Invalid or expired session");
        state.socket.close(4401, "Unknown account");
        return;
      }
      state.userId = userId;
      clearTimeout(state.authTimer);
      const expiresIn = Math.max(0, expiresAt * 1000 - Date.now());
      state.authTimer = setTimeout(
        () => state.socket.close(4401, "Session expired"),
        expiresIn,
      );
      state.authTimer.unref();
      this.send(state.socket, { type: "authenticated", userId });
      this.log(null, null, "authenticated");
      return;
    }
    if (!state.userId) {
      this.sendError(
        state,
        "UNAUTHORIZED",
        "Authenticate before sending messages",
      );
      state.socket.close(4401, "Authentication required");
      return;
    }
    if (message.type === "ping") {
      this.send(state.socket, {
        type: "pong",
        ts: message.ts,
        serverTime: Date.now(),
      });
      return;
    }
    if (message.type === "join") {
      await this.join(state, message.workspaceId, message.peerId);
      return;
    }
    if (message.type === "leave") {
      this.removePeer(state, "leave");
      return;
    }
    if (message.type !== "signal") return;
    if (!state.workspaceId || !state.peer) {
      this.sendError(
        state,
        "NOT_IN_WORKSPACE",
        "Join a workspace before signaling",
      );
      return;
    }
    const target = this.rooms.get(state.workspaceId)?.get(message.to);
    if (!target) {
      this.sendError(
        state,
        "PEER_NOT_FOUND",
        "The target peer is not in this workspace",
      );
      this.log(state.workspaceId, state.peer.peerId, "signal-target-missing");
      return;
    }
    this.send(target.socket, {
      type: "signal",
      from: state.peer.peerId,
      data: message.data,
    });
    this.log(
      state.workspaceId,
      state.peer.peerId,
      `signal-relayed-${message.data.kind}`,
    );
  }

  private async join(
    state: SocketState,
    workspaceId: string,
    peerId: string,
  ): Promise<void> {
    if (!state.userId) return;
    if (state.workspaceId && state.peer) {
      if (state.workspaceId === workspaceId && state.peer.peerId === peerId) {
        this.sendJoined(state, workspaceId);
      } else {
        this.sendError(
          state,
          "ALREADY_IN_WORKSPACE",
          "Leave the current workspace first",
        );
      }
      return;
    }
    const result = await this.pool.query<MemberRecord>(
      `SELECT u.id AS user_id, u.display_name, m.role, u.fingerprint
       FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [workspaceId, state.userId],
    );
    const member = result.rows[0];
    if (!member) {
      this.sendError(
        state,
        "NOT_A_MEMBER",
        "You are not a member of this workspace",
      );
      this.log(workspaceId, peerId, "join-rejected-non-member");
      return;
    }
    let room = this.rooms.get(workspaceId);
    if (room?.has(peerId)) {
      this.sendError(
        state,
        "PEER_ID_IN_USE",
        "This peer ID is already connected",
      );
      return;
    }
    if (room && room.size >= 8) {
      this.sendError(
        state,
        "ROOM_FULL",
        "Workspace rooms are limited to 8 peers",
      );
      return;
    }
    if (!room) {
      room = new Map();
      this.rooms.set(workspaceId, room);
    }
    const peer: PeerDirectoryEntry = {
      peerId,
      userId: member.user_id,
      displayName: member.display_name,
      role: member.role,
      fingerprint: member.fingerprint,
    };
    const peers = Array.from(room.values(), (entry) => entry.peer).filter(
      (entry): entry is PeerDirectoryEntry => entry !== null,
    );
    state.workspaceId = workspaceId;
    state.peer = peer;
    room.set(peerId, state);
    this.send(state.socket, { type: "joined", workspaceId, peerId, peers });
    this.broadcast(workspaceId, { type: "peer-joined", peer }, state);
    this.log(workspaceId, peerId, "joined");
  }

  private sendJoined(state: SocketState, workspaceId: string): void {
    if (!state.peer) return;
    const peers = Array.from(this.rooms.get(workspaceId)?.values() ?? [])
      .filter((entry) => entry !== state && entry.peer !== null)
      .map((entry) => entry.peer!);
    this.send(state.socket, {
      type: "joined",
      workspaceId,
      peerId: state.peer.peerId,
      peers,
    });
  }

  private removePeer(state: SocketState, event: string): void {
    const workspaceId = state.workspaceId;
    const peer = state.peer;
    if (!workspaceId || !peer) return;
    const room = this.rooms.get(workspaceId);
    room?.delete(peer.peerId);
    if (room) {
      this.broadcast(workspaceId, { type: "peer-left", peerId: peer.peerId });
      if (room.size === 0) this.rooms.delete(workspaceId);
    }
    state.workspaceId = null;
    state.peer = null;
    this.log(workspaceId, peer.peerId, event);
  }

  private broadcast(
    workspaceId: string,
    message: ServerSignalMessage,
    except?: SocketState,
  ): void {
    for (const state of this.rooms.get(workspaceId)?.values() ?? []) {
      if (state !== except) this.send(state.socket, message);
    }
  }

  private sendError(state: SocketState, code: string, message: string): void {
    this.send(state.socket, { type: "error", code, message });
  }

  private send(socket: WebSocket, message: ServerSignalMessage): void {
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify(message));
  }

  private log(
    workspaceId: string | null,
    peerId: string | null,
    event: string,
  ): void {
    console.info(
      `[room=${workspaceId ?? "-"}] [peer=${peerId?.slice(0, 8) ?? "-"}] ${event}`,
    );
  }
}
