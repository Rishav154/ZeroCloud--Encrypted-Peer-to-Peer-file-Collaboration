import {
  parseClientMessage,
  type PeerDirectoryEntry,
  type ServerSignalMessage,
  type WorkspaceMemberDirectory,
  type WorkspaceRole,
  type NearbyPeer,
} from "@zerocloud/shared";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import { verifySessionToken } from "./auth/session.js";
import { logger } from "./logging.js";
import { nearbyGroupKey, withinWindow } from "./nearby.js";

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
  userSlotAcquired: boolean;
  clientIp: string;
  nearby: NearbyPeer | null;
  nearbyGroup: string | null;
  nearbyPeerId: string | null;
  nearbyEnableTimes: number[];
  nearbySignalTimes: number[];
  nearbyUserSlot: boolean;
};

export type UserConnectionLimiter = {
  acquireUser: (userId: string) => boolean;
  releaseUser: (userId: string) => void;
};

export class WorkspaceHub {
  private readonly rooms = new Map<string, Map<string, SocketState>>();
  private readonly nearbyGroups = new Map<string, Map<string, SocketState>>();
  private readonly nearbyUserCounts = new Map<string, number>();

  constructor(
    private readonly pool: Pool,
    private readonly jwtSecret: string,
    private readonly connectionLimits?: UserConnectionLimiter,
    private readonly nearbySecret = "",
  ) {}

  accept(socket: WebSocket, clientIp = "unknown"): void {
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
      userSlotAcquired: false,
      clientIp,
      nearby: null,
      nearbyGroup: null,
      nearbyPeerId: null,
      nearbyEnableTimes: [],
      nearbySignalTimes: [],
      nearbyUserSlot: false,
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
      if (state.userSlotAcquired && state.userId) {
        this.connectionLimits?.releaseUser(state.userId);
      }
      this.removeNearby(state);
      this.releaseNearbyUserSlot(state);
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
    if (message.type === "ping") {
      this.send(state.socket, {
        type: "pong",
        ts: message.ts,
        serverTime: Date.now(),
      });
      return;
    }
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
      if (this.connectionLimits && !this.connectionLimits.acquireUser(userId)) {
        this.sendError(state, "CONNECTION_LIMIT", "Maximum connections for this account reached");
        state.socket.close(4429, "Per-user connection limit reached");
        return;
      }
      state.userId = userId;
      state.userSlotAcquired = Boolean(this.connectionLimits);
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
    if (message.type === "join") {
      await this.join(state, message.workspaceId, message.peerId);
      return;
    }
    if (message.type === "leave") {
      this.removePeer(state, "leave");
      return;
    }
    if (message.type === "nearby-enable") { await this.enableNearby(state, message.peerId, message.alias); return; }
    if (message.type === "nearby-disable") { if (!this.rateNearby(state, "enable")) return; this.removeNearby(state); return; }
    if (message.type === "nearby-signal") { this.relayNearby(state, message.to, message.data); return; }
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

  private async enableNearby(state: SocketState, peerId: string, alias: string): Promise<void> {
    if (!this.rateNearby(state, "enable")) return;
    if (state.nearby) { this.sendError(state, "NOT_ENABLED", "Nearby is already enabled"); return; }
    if (!state.userId) return;
    const count = this.nearbyUserCounts.get(state.userId) ?? 0;
    if (count >= 3) { this.sendError(state, "GROUP_FULL", "Maximum nearby-enabled sockets reached"); return; }
    this.nearbyUserCounts.set(state.userId, count + 1);
    state.nearbyUserSlot = true;
    let groupKey: string;
    try { groupKey = nearbyGroupKey(this.nearbySecret, state.clientIp); }
    catch { this.releaseNearbyUserSlot(state); this.sendError(state, "NOT_ENABLED", "Could not determine network group"); return; }
    let group = this.nearbyGroups.get(groupKey);
    if (group?.has(peerId)) { this.releaseNearbyUserSlot(state); this.sendError(state, "NOT_ENABLED", "Peer ID is already in use"); return; }
    if (group && group.size >= 50) { this.releaseNearbyUserSlot(state); this.sendError(state, "GROUP_FULL", "Nearby group is full"); return; }
    if (!group) { group = new Map(); this.nearbyGroups.set(groupKey, group); }
    state.nearbyGroup = groupKey; state.nearbyPeerId = peerId; group.set(peerId, state);
    let result;
    try { result = await this.pool.query<{ fingerprint: string; key_alg: "X25519" | "P-256" }>("SELECT fingerprint, key_alg FROM users WHERE id = $1", [state.userId]); }
    catch { this.removeNearby(state); this.sendError(state, "NOT_ENABLED", "Could not load nearby identity"); return; }
    if (state.socket.readyState !== WebSocket.OPEN) { this.removeNearby(state); return; }
    const identity = result.rows[0];
    if (!identity) { this.removeNearby(state); return; }
    const peer: NearbyPeer = { peerId, alias, fingerprint: identity.fingerprint, keyAlg: identity.key_alg };
    const peers = [...group.values()].map((entry) => entry.nearby).filter((entry): entry is NearbyPeer => entry !== null);
    state.nearby = peer; state.nearbyGroup = groupKey; group.set(peerId, state);
    this.send(state.socket, { type: "nearby-peers", peers });
    this.send(state.socket, { type: "nearby-group-info", groupId: groupKey.slice(0, 6) });
    this.broadcastNearby(groupKey, { type: "nearby-peer-joined", peer }, state);
    logger.debug({ groupId: groupKey.slice(0, 6), event: "nearby-enabled" }, "nearby event");
  }

  private relayNearby(state: SocketState, to: string, data: import("@zerocloud/shared").NearbySignalData): void {
    if (!this.rateNearby(state, "signal")) return;
    if (!state.nearby || !state.nearbyGroup) { this.sendError(state, "NOT_ENABLED", "Enable Nearby before signaling"); return; }
    const target = this.nearbyGroups.get(state.nearbyGroup)?.get(to);
    if (!target?.nearby) { this.sendError(state, "NOT_ENABLED", "Target is not nearby-enabled"); return; }
    this.send(target.socket, { type: "nearby-signal", from: state.nearby.peerId, data });
  }

  private rateNearby(state: SocketState, kind: "enable" | "signal"): boolean {
    const now = Date.now();
    const list = kind === "enable" ? state.nearbyEnableTimes : state.nearbySignalTimes;
    const recent = withinWindow(list, now, 60_000);
    const limit = kind === "enable" ? 6 : 120;
    if (recent.length >= limit) { this.sendError(state, "RATE_LIMITED", "Nearby rate limit exceeded"); return false; }
    recent.push(now);
    if (kind === "enable") state.nearbyEnableTimes = recent; else state.nearbySignalTimes = recent;
    return true;
  }

  private removeNearby(state: SocketState): void {
    const peer = state.nearby;
    const key = state.nearbyGroup;
    const peerId = state.nearbyPeerId;
    if (!key || !peerId) return;
    const group = this.nearbyGroups.get(key);
    group?.delete(peerId);
    if (group) { if (peer) this.broadcastNearby(key, { type: "nearby-peer-left", peerId: peer.peerId }); if (!group.size) this.nearbyGroups.delete(key); }
    state.nearby = null; state.nearbyGroup = null; state.nearbyPeerId = null;
    this.releaseNearbyUserSlot(state);
    logger.debug({ groupId: key.slice(0, 6), event: "nearby-left" }, "nearby event");
  }

  private releaseNearbyUserSlot(state: SocketState): void {
    if (!state.nearbyUserSlot || !state.userId) return;
    const count = this.nearbyUserCounts.get(state.userId) ?? 0;
    if (count <= 1) this.nearbyUserCounts.delete(state.userId); else this.nearbyUserCounts.set(state.userId, count - 1);
    state.nearbyUserSlot = false;
  }

  private broadcastNearby(groupKey: string, message: import("@zerocloud/shared").ServerSignalMessage, except?: SocketState): void {
    for (const state of this.nearbyGroups.get(groupKey)?.values() ?? []) if (state !== except && state.nearby) this.send(state.socket, message);
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
    logger.info({ room: workspaceId, peerId: peerId?.slice(0, 8) ?? null, event }, "websocket event");
  }
}
