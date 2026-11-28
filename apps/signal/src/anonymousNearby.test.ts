import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { attachAnonymousNearby } from "./anonymousNearby.js";

vi.mock("./db/pool.js", () => { throw new Error("Anonymous Nearby must never load database code"); });

const config = { ALLOWED_ORIGIN: "http://localhost:3000", TRUST_PROXY_HOPS: 0, NEARBY_SECRET: "x".repeat(32), NEARBY_MAX_SOCKETS: 20 };
let closeCurrent: (() => Promise<void>) | null = null;
afterEach(async () => { if (closeCurrent) await closeCurrent(); closeCurrent = null; });

describe("anonymous Nearby endpoint", () => {
  it("lists a server-computed fingerprint and drops workspace messages", async () => {
    const server = createServer();
    const nearby = attachAnonymousNearby(server, config);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test address");
    closeCurrent = async () => { await new Promise<void>((resolve) => nearby.close(resolve)); await new Promise<void>((resolve) => server.close(() => resolve())); };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/nearby`, { origin: config.ALLOWED_ORIGIN });
    const received: unknown[] = [];
    socket.on("message", (message) => received.push(JSON.parse(message.toString()) as unknown));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const publicKey = new Uint8Array(32).fill(7);
    socket.send(JSON.stringify({ type: "nearby-enable", peerId: "00000000-0000-4000-8000-000000000001", alias: "Amber Acorn", publicKey: Buffer.from(publicKey).toString("base64"), keyAlg: "X25519" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(received).toContainEqual({ type: "nearby-peers", peers: [{ peerId: "00000000-0000-4000-8000-000000000001", alias: "Amber Acorn", fingerprint: createHash("sha256").update(publicKey).digest("hex"), keyAlg: "X25519" }] });
    socket.send(JSON.stringify({ type: "join", workspaceId: "00000000-0000-4000-8000-000000000002", peerId: "00000000-0000-4000-8000-000000000003" }));
    socket.send(JSON.stringify({ type: "sync", workspaceId: "00000000-0000-4000-8000-000000000002" }));
    socket.send(JSON.stringify({ type: "auth", token: "invalid" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(nearby.counts()).toEqual({ sockets: 1, enabled: 1, groups: 1 });
    expect(received.some((value) => JSON.stringify(value).includes("workspace"))).toBe(false);
    socket.close();
  });

  it("rejects malformed public keys and unknown algorithms", async () => {
    const server = createServer();
    const nearby = attachAnonymousNearby(server, config);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing test address");
    closeCurrent = async () => { await new Promise<void>((resolve) => nearby.close(resolve)); await new Promise<void>((resolve) => server.close(() => resolve())); };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/nearby`, { origin: config.ALLOWED_ORIGIN });
    const messages: unknown[] = []; socket.on("message", (message) => messages.push(JSON.parse(message.toString()) as unknown));
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "nearby-enable", peerId: "00000000-0000-4000-8000-000000000001", alias: "Bad", publicKey: Buffer.alloc(31).toString("base64"), keyAlg: "X25519" }));
    socket.send(JSON.stringify({ type: "nearby-enable", peerId: "00000000-0000-4000-8000-000000000002", alias: "Bad", publicKey: Buffer.concat([Buffer.from([3]), Buffer.alloc(64)]).toString("base64"), keyAlg: "P-256" }));
    socket.send(JSON.stringify({ type: "nearby-enable", peerId: "00000000-0000-4000-8000-000000000003", alias: "Bad", publicKey: "%%%", keyAlg: "X25519" }));
    socket.send(JSON.stringify({ type: "nearby-enable", peerId: "00000000-0000-4000-8000-000000000004", alias: "Bad", publicKey: Buffer.alloc(32).toString("base64"), keyAlg: "unknown" }));
    socket.send(JSON.stringify({ type: "nearby-enable", peerId: "00000000-0000-4000-8000-000000000005", alias: "Bad", publicKey: Buffer.alloc(32).toString("base64"), keyAlg: "X25519", fingerprint: "0".repeat(64) }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages.filter((message) => JSON.stringify(message).includes("Invalid public key"))).toHaveLength(3);
    expect(messages.filter((message) => JSON.stringify(message).includes("Nearby enable message is invalid"))).toHaveLength(2);
    expect(nearby.counts().enabled).toBe(0);
    socket.close();
  });
});
