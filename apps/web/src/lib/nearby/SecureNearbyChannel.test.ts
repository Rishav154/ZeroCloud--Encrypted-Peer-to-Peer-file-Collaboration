import { describe, expect, it, vi } from "vitest";
import { nearbyControlPayloadSchema, openNearbyControl, NearbyReplayGuard } from "@zerocloud/shared";
import { SecureNearbyChannel } from "./SecureNearbyChannel";

async function sessionKey(): Promise<CryptoKey> { return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); }

describe("SecureNearbyChannel", () => {
  it("seals file controls and passes binary chunks through", async () => {
    const output: Array<string | ArrayBuffer> = [];
    const raw = { readyState: "open", bufferedAmount: 0, bufferedAmountLowThreshold: 0, send: (data: string | ArrayBuffer) => output.push(data), addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as RTCDataChannel;
    const key = await sessionKey();
    const sender = "a".repeat(64); const receiver = "b".repeat(64);
    const channel = new SecureNearbyChannel(raw, key, sender, receiver);
    channel.send(JSON.stringify({ type: "file-accept", transferId: 42 }));
    await vi.waitFor(() => expect(output).toHaveLength(1));
    const outer = JSON.parse(String(output[0])) as unknown;
    const replay = new NearbyReplayGuard();
    const opened = await openNearbyControl(key, outer, sender, receiver, replay, nearbyControlPayloadSchema);
    expect(opened).toEqual({ type: "nearby-file-accept", transferId: 42 });
    const chunk = new ArrayBuffer(8);
    channel.send(chunk);
    await vi.waitFor(() => expect(output).toHaveLength(2));
    expect(output[1]).toBe(chunk);
  });

  it("keeps invite secrets out of the cleartext channel envelope", async () => {
    const output: Array<string | ArrayBuffer> = [];
    const raw = { readyState: "open", bufferedAmount: 0, bufferedAmountLowThreshold: 0, send: (data: string | ArrayBuffer) => output.push(data), addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as RTCDataChannel;
    const key = await sessionKey();
    const secret = "s".repeat(43);
    const channel = new SecureNearbyChannel(raw, key, "a".repeat(64), "b".repeat(64));
    channel.sendNearbyControl({ type: "workspace-invite", inviteId: "00000000-0000-4000-8000-000000000001", secret, workspaceName: "Private", role: "viewer", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await vi.waitFor(() => expect(output).toHaveLength(1));
    expect(String(output[0])).not.toContain(secret);
  });
});
