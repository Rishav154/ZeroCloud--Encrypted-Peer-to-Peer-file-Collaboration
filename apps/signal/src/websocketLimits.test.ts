import { once } from "node:events";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

describe("WebSocket payload limit", () => {
  it("closes oversized frames with the standard message-too-large code", async () => {
    const server = new WebSocketServer({ port: 0, maxPayload: 64 });
    server.on("connection", (socket) => socket.on("error", () => undefined));
    server.on("error", () => undefined);
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    client.on("error", () => undefined);
    await once(client, "open");
    const closed = once(client, "close") as Promise<[number, Buffer]>;
    client.send("x".repeat(256));
    const [code] = await closed;
    expect(code).toBe(1009);
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
