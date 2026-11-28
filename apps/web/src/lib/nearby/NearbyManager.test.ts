import { afterEach, describe, expect, it, vi } from "vitest";
import { NearbyManager } from "./NearbyManager";
import type { StoredIdentity } from "../identity/identityStore";

describe("NearbyManager connection requests", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("fails after ten seconds without an offer and retries with a new request", () => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", vi.fn(() => ({ close: vi.fn() })));
    const sent: Array<{ type: string; to: string; data: unknown }> = [];
    const manager = new NearbyManager({} as unknown as StoredIdentity, (message) => { sent.push(message); return true; });
    const smaller = "00000000-0000-4000-8000-000000000001";
    manager.localPeerId = "00000000-0000-4000-8000-000000000002";
    manager.enable([{ peerId: smaller, alias: "Bronze Locust", fingerprint: "a".repeat(64), keyAlg: "P-256" }]);
    const states: string[] = [];
    manager.events.on("peer", (peer) => states.push(peer.state));
    manager.connect(smaller);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.data).toEqual({ kind: "connect-request" });
    vi.advanceTimersByTime(10_000);
    expect(states).toContain("failed");
    manager.connect(smaller);
    expect(sent).toHaveLength(2);
    manager.disable();
  });
});
