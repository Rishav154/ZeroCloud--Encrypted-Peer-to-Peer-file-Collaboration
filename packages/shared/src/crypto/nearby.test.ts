import { describe, expect, it } from "vitest";
import { z } from "zod";
import { NearbyReplayGuard, nearbyTextPayloadSchema, openNearbyControl, sealNearbyControl } from "./nearby.js";

const payloadSchema = z.object({ type: z.literal("workspace-invite"), secret: z.string() }).strict();
const context = { messageType: "workspace-invite" as const, senderFingerprint: "a".repeat(64), receiverFingerprint: "b".repeat(64), seq: 1 };

async function key(): Promise<CryptoKey> { return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]); }

describe("nearby sealed controls", () => {
  it("seals nearby text with message-type binding and strict size validation", async () => {
    const sessionKey = await key();
    const text = { type: "nearby-text", id: "00000000-0000-4000-8000-000000000001", text: "plain text" };
    const envelope = await sealNearbyControl(sessionKey, { ...context, messageType: "nearby-text", seq: 1 }, text);
    expect(await openNearbyControl(sessionKey, envelope, context.senderFingerprint, context.receiverFingerprint, new NearbyReplayGuard(), nearbyTextPayloadSchema)).toEqual(text);
    await expect(openNearbyControl(sessionKey, { ...envelope, messageType: "invite-ack" }, context.senderFingerprint, context.receiverFingerprint, new NearbyReplayGuard(), nearbyTextPayloadSchema)).rejects.toThrow();
    expect(nearbyTextPayloadSchema.safeParse({ ...text, extra: true }).success).toBe(false);
    expect(nearbyTextPayloadSchema.safeParse({ ...text, text: "x".repeat(4097) }).success).toBe(false);
  });
  it("authenticates message type, sender, receiver, and sequence", async () => {
    const sessionKey = await key();
    const envelope = await sealNearbyControl(sessionKey, context, { type: "workspace-invite", secret: "memory-only" });
    const mutations = [
      { ...envelope, messageType: "invite-ack" as const },
      { ...envelope, seq: 2 },
    ];
    for (const altered of mutations) await expect(openNearbyControl(sessionKey, altered, context.senderFingerprint, context.receiverFingerprint, new NearbyReplayGuard(), payloadSchema)).rejects.toThrow();
    await expect(openNearbyControl(sessionKey, envelope, "c".repeat(64), context.receiverFingerprint, new NearbyReplayGuard(), payloadSchema)).rejects.toThrow();
    await expect(openNearbyControl(sessionKey, envelope, context.senderFingerprint, "c".repeat(64), new NearbyReplayGuard(), payloadSchema)).rejects.toThrow();
  });

  it("rejects replayed sequence numbers", async () => {
    const sessionKey = await key();
    const envelope = await sealNearbyControl(sessionKey, context, { type: "workspace-invite", secret: "memory-only" });
    const replay = new NearbyReplayGuard();
    expect(await openNearbyControl(sessionKey, envelope, context.senderFingerprint, context.receiverFingerprint, replay, payloadSchema)).toEqual({ type: "workspace-invite", secret: "memory-only" });
    await expect(openNearbyControl(sessionKey, envelope, context.senderFingerprint, context.receiverFingerprint, replay, payloadSchema)).rejects.toThrow("replay");
  });
});
