import { WebSocket } from "ws";

const url = process.argv[2];
if (!url || !/^wss?:\/\//.test(url)) {
  process.stderr.write("Usage: pnpm test:load-nearby <ws(s)-url>\n");
  process.exit(2);
}
const target = url.replace(/\/ws(?:\/nearby)?\/?$/, "") + "/ws/nearby";
const sockets = [];
const origin = new URL(url.replace(/^ws/, "http")).origin;
const openSocket = (index) => new Promise((resolve, reject) => {
  const socket = new WebSocket(target, { origin }); sockets.push(socket);
  const closed = new Promise((closeResolve) => socket.once("close", (code, reason) => closeResolve({ code, reason: reason.toString() })));
  socket.once("open", () => resolve({ socket, opened: true, closed }));
  socket.once("unexpected-response", (_request, response) => resolve({ socket, opened: false, status: response.statusCode, index, closed }));
  socket.once("error", reject);
});
const run = async () => {
  const globalCapFlag = process.argv[3];
  if (globalCapFlag === "--global-cap") {
    const cap = Number(process.argv[4]);
    if (!Number.isInteger(cap) || cap < 1 || cap > 9) throw new Error("--global-cap must be 1 through 9 so the per-IP cap does not interfere");
    for (let index = 0; index < cap; index += 1) {
      const result = await openSocket(index);
      if (!result.opened) throw new Error(`Socket ${index + 1} was refused with HTTP ${result.status}`);
    }
    const last = await openSocket(cap);
    if (!last.opened) throw new Error(`Capacity probe was refused with HTTP ${last.status} before WebSocket close`);
    const closed = await Promise.race([last.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for global-cap close")), 3000))]);
    if (closed.code !== 4425) throw new Error(`Expected close code 4425, received ${closed.code} (${closed.reason})`);
    return { opened: cap, refused: true, global: true };
  }
  for (let index = 0; index < 10; index += 1) {
    const result = await openSocket(index);
    if (!result.opened) throw new Error(`Socket ${index + 1} was refused with HTTP ${result.status}`);
  }
  const last = await openSocket(10);
  if (last.opened || last.status !== 429) throw new Error(`Expected the 11th socket to receive HTTP 429, got ${last.status ?? "open"}`);
  return { opened: 10, refused: true };
};
const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Timed out waiting for the 11th socket refusal")), 10_000));
try {
  const result = await Promise.race([run(), timeout]);
  process.stdout.write(result.global ? `Opened ${result.opened} sockets; the next socket closed with code 4425 (configured global-cap probe).\n` : `Opened ${result.opened} sockets; the 11th was refused (per-IP cap: 10).\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Load check failed"}\n`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
}
