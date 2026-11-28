import { describe, expect, it } from "vitest";
import { routePeerMessage } from "./router";

describe("peer message channel router", () => {
  it("allows hello and ready only on their explicit channels", () => {
    const hello = { type: "hello", v: 1, alg: "P-256", publicKey: "key", nonce: "nonce" };
    expect(routePeerMessage("zc-nearby", hello).accepted).toBe(true);
    expect(routePeerMessage("zc-data", hello).accepted).toBe(true);
  });
  it("allows hello-commit only on nearby with a bounded base64 digest", () => {
    expect(routePeerMessage("zc-nearby", { type: "hello-commit", c: "A".repeat(43) + "=" }).accepted).toBe(true);
    expect(routePeerMessage("zc-nearby", { type: "hello-commit", c: "x".repeat(129) }).accepted).toBe(false);
    expect(routePeerMessage("zc-data", { type: "hello-commit", c: "A".repeat(43) + "=" }).accepted).toBe(false);
  });
  it.each(["nearby-file-offer", "nearby-file-accept", "nearby-file-reject", "nearby-file-complete", "nearby-file-ack", "nearby-file-cancel", "workspace-invite", "invite-ack"])("recognizes the opened Checkpoint B control %s", (type) => {
    expect(routePeerMessage("zc-nearby", { type }, undefined, true).accepted).toBe(true);
  });
  it.each(["sync", "manifest", "ws-proof", "chat", "unknown"]) ("drops %s on nearby", (type) => {
    let dropped = 0;
    expect(routePeerMessage("zc-nearby", { type }, () => { dropped += 1; }).accepted).toBe(false);
    expect(dropped).toBe(1);
  });
  it("drops nearby control messages on workspace channels", () => {
    expect(routePeerMessage("zc-data", { type: "nearby-file-offer" }).accepted).toBe(false);
  });
  it("drops signaling-only connect requests on the data channel and malformed handshakes", () => {
    expect(routePeerMessage("zc-nearby", { type: "nearby-signal", data: { kind: "connect-request" } }).accepted).toBe(false);
    expect(routePeerMessage("zc-nearby", { type: "nearby-file-offer" }).accepted).toBe(false);
    expect(routePeerMessage("zc-nearby", { type: "hello", v: 1, alg: "P-256", publicKey: "key", nonce: "nonce", extra: true }).accepted).toBe(false);
  });
});
