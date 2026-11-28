import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { nearbyGroupKey, deriveClientIp, withinWindow } from "./nearby.js";

const uuid = z.string().uuid();
const alias = z.string().min(1).max(24).regex(/^[A-Za-z0-9 _-]+$/);
const signal = z.union([
  z.object({ kind: z.enum(["offer", "answer"]), sdp: z.string().max(24_000) }).strict(),
  z.object({ kind: z.literal("ice"), candidate: z.object({ candidate: z.string().max(4000), sdpMid: z.string().nullable().optional(), sdpMLineIndex: z.number().nullable().optional(), usernameFragment: z.string().nullable().optional() }).strict() }).strict(),
  z.object({ kind: z.literal("connect-request") }).strict(),
]);
const enable = z.object({ type: z.literal("nearby-enable"), peerId: uuid, alias, publicKey: z.string(), keyAlg: z.enum(["X25519", "P-256"]) }).strict();
const disable = z.object({ type: z.literal("nearby-disable") }).strict();
const relay = z.object({ type: z.literal("nearby-signal"), to: uuid, data: signal }).strict();
type Peer = { peerId: string; alias: string; fingerprint: string; keyAlg: "X25519" | "P-256" };
type State = { socket: WebSocket; ip: string; peer: Peer | null; group: string | null; enableTimes: number[]; signalTimes: number[]; missedPongs: number };

export type AnonymousNearbyConfig = { ALLOWED_ORIGIN: string; TRUST_PROXY_HOPS: number; NEARBY_SECRET: string; NEARBY_MAX_SOCKETS?: number; NEARBY_MAX_PAYLOAD_BYTES?: number; NEARBY_MAX_SOCKETS_PER_IP?: number; NEARBY_NEW_CONNECTIONS_PER_MINUTE?: number; NEARBY_GROUP_CAP?: number; NEARBY_ENABLES_PER_MINUTE?: number; NEARBY_SIGNALS_PER_MINUTE?: number; NEARBY_ENABLE_TIMEOUT_MS?: number };

/** In-memory anonymous relay. Deliberately imports no database, auth, or workspace modules. */
export function attachAnonymousNearby(server: Server, config: AnonymousNearbyConfig): { close: (done?: () => void) => void; counts: () => { sockets: number; enabled: number; groups: number } } {
  const maxSockets = config.NEARBY_MAX_SOCKETS ?? 2000;
  const maxPayload = config.NEARBY_MAX_PAYLOAD_BYTES ?? 32 * 1024;
  const maxSocketsPerIp = config.NEARBY_MAX_SOCKETS_PER_IP ?? 10;
  const newConnectionsPerMinute = config.NEARBY_NEW_CONNECTIONS_PER_MINUTE ?? 20;
  const groupCap = config.NEARBY_GROUP_CAP ?? 30;
  const enablesPerMinute = config.NEARBY_ENABLES_PER_MINUTE ?? 6;
  const signalsPerMinute = config.NEARBY_SIGNALS_PER_MINUTE ?? 120;
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const states = new Map<WebSocket, State>();
  const groups = new Map<string, Map<string, State>>();
  const newConnections = new Map<string, number[]>();
  const socketsPerIp = new Map<string, number>();
  const validBase64 = (value: string): Uint8Array | null => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;
    return Uint8Array.from(Buffer.from(value, "base64"));
  };
  const send = (socket: WebSocket, value: unknown): void => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const remove = (state: State): void => {
    if (state.group && state.peer) {
      const group = groups.get(state.group);
      group?.delete(state.peer.peerId);
      if (group) for (const other of group.values()) send(other.socket, { type: "nearby-peer-left", peerId: state.peer.peerId });
      if (!group?.size) groups.delete(state.group);
    }
    state.peer = null; state.group = null;
  };
  const release = (state: State): void => {
    remove(state); states.delete(state.socket);
    const count = Math.max(0, (socketsPerIp.get(state.ip) ?? 1) - 1);
    if (count) socketsPerIp.set(state.ip, count); else socketsPerIp.delete(state.ip);
  };
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws/nearby" || request.headers.origin !== config.ALLOWED_ORIGIN) {
      if (request.url === "/ws/nearby") { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); }
      return;
    }
    const ip = deriveClientIp(request.headers["x-forwarded-for"], request.socket.remoteAddress, config.TRUST_PROXY_HOPS);
    const ipCount = socketsPerIp.get(ip) ?? 0;
    const times = withinWindow(newConnections.get(ip) ?? [], Date.now(), 60_000);
    if (ipCount >= maxSocketsPerIp || times.length >= newConnectionsPerMinute) { socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n"); socket.destroy(); return; }
    newConnections.set(ip, [...times, Date.now()]); socketsPerIp.set(ip, ipCount + 1);
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request, ip));
  });
  wss.on("connection", (socket: WebSocket, _request: IncomingMessage, ip: string) => {
    const state: State = { socket, ip, peer: null, group: null, enableTimes: [], signalTimes: [], missedPongs: 0 };
    states.set(socket, state);
    socket.on("pong", () => { state.missedPongs = 0; });
    if (states.size > maxSockets) { socket.close(4425, "Nearby global capacity reached (NEARBY_MAX_SOCKETS)"); return; }
    const authTimer = setTimeout(() => { if (!state.peer) socket.close(4408, "Nearby enable timeout"); }, config.NEARBY_ENABLE_TIMEOUT_MS ?? 15_000);
    socket.on("message", (data, isBinary) => {
      if (isBinary) { socket.close(1003, "Text messages required"); return; }
      let value: unknown; try { value = JSON.parse(data.toString()); } catch { socket.close(1007, "Invalid JSON"); return; }
      if (Buffer.byteLength(data.toString()) > maxPayload) { socket.close(1009, "Payload too large"); return; }
      const enabled = enable.safeParse(value);
      if (enabled.success) {
        state.enableTimes = withinWindow(state.enableTimes, Date.now(), 60_000);
        if (state.enableTimes.length >= enablesPerMinute) { send(socket, { type: "error", code: "RATE_LIMITED", message: "Nearby enable limit reached" }); return; }
        if (state.peer) { send(socket, { type: "error", code: "NOT_ENABLED", message: "Nearby already enabled" }); return; }
        state.enableTimes.push(Date.now());
        const raw = validBase64(enabled.data.publicKey);
        if (!raw || (enabled.data.keyAlg === "X25519" ? raw.length !== 32 : raw.length !== 65 || raw[0] !== 4)) { send(socket, { type: "error", code: "INVALID_KEY", message: "Invalid public key" }); return; }
        const fingerprint = createHash("sha256").update(raw).digest("hex");
        const key = nearbyGroupKey(config.NEARBY_SECRET, ip);
        let group = groups.get(key); if (!group) { group = new Map(); groups.set(key, group); }
        if (group.has(enabled.data.peerId)) { send(socket, { type: "error", code: "DUPLICATE_PEER", message: "Nearby peer ID is already in use" }); return; }
        if (group.size >= groupCap) { send(socket, { type: "error", code: "GROUP_FULL", message: "Nearby group is full" }); return; }
        const peer: Peer = { peerId: enabled.data.peerId, alias: enabled.data.alias, fingerprint, keyAlg: enabled.data.keyAlg };
        state.peer = peer; state.group = key; group.set(peer.peerId, state); clearTimeout(authTimer);
        send(socket, { type: "nearby-peers", peers: [...group.values()].flatMap((entry) => entry.peer ? [entry.peer] : []) });
        send(socket, { type: "nearby-group-info", groupId: key.slice(0, 6) });
        for (const other of group.values()) if (other !== state) send(other.socket, { type: "nearby-peer-joined", peer });
        return;
      }
      if (value && typeof value === "object" && "type" in value && value.type === "nearby-enable") { send(socket, { type: "error", code: "INVALID_MESSAGE", message: "Nearby enable message is invalid" }); return; }
      if (disable.safeParse(value).success) {
        state.enableTimes = withinWindow(state.enableTimes, Date.now(), 60_000);
        if (state.enableTimes.length >= enablesPerMinute) { send(socket, { type: "error", code: "RATE_LIMITED", message: "Nearby enable limit reached" }); return; }
        state.enableTimes.push(Date.now()); remove(state); return;
      }
      const signaled = relay.safeParse(value);
      if (signaled.success) {
        state.signalTimes = withinWindow(state.signalTimes, Date.now(), 60_000);
        if (state.signalTimes.length >= signalsPerMinute) { send(socket, { type: "error", code: "RATE_LIMITED", message: "Nearby signal limit reached" }); return; }
        state.signalTimes.push(Date.now());
        const target = state.group ? groups.get(state.group)?.get(signaled.data.to) : undefined;
        if (state.peer && target?.peer) send(target.socket, { type: "nearby-signal", from: state.peer.peerId, data: signaled.data.data });
      }
    });
    socket.on("close", () => { clearTimeout(authTimer); release(state); });
    socket.on("error", () => { clearTimeout(authTimer); release(state); });
  });
  const heartbeat = setInterval(() => { for (const socket of wss.clients) { const state = states.get(socket); if (!state || socket.readyState !== WebSocket.OPEN) continue; if (state.missedPongs >= 2) { socket.terminate(); continue; } state.missedPongs += 1; socket.ping(); } }, 20_000);
  heartbeat.unref();
  return { close: (done) => { clearInterval(heartbeat); for (const socket of wss.clients) socket.close(1001, "Server shutting down"); wss.close(done); }, counts: () => ({ sockets: states.size, enabled: [...states.values()].filter((state) => state.peer !== null).length, groups: groups.size }) };
}
