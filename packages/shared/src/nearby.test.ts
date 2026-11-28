import { describe, expect, it } from "vitest";
import { connectRequestSchema, nearbyControlPayloadSchema, nearbyRelaySchema } from "./index.js";

describe("nearby signaling schemas", () => {
  it("accepts a fieldless connect request and rejects extensions", () => {
    expect(connectRequestSchema.safeParse({ kind: "connect-request" }).success).toBe(true);
    expect(connectRequestSchema.safeParse({ kind: "connect-request", fingerprint: "secret" }).success).toBe(false);
  });
  it("accepts connect requests as nearby signal payloads", () => {
    expect(nearbyRelaySchema.safeParse({ type: "nearby-signal", to: "00000000-0000-4000-8000-000000000001", data: { kind: "connect-request" } }).success).toBe(true);
  });
  it("rejects extra fields in file and invite controls", () => {
    expect(nearbyControlPayloadSchema.safeParse({ type: "nearby-file-accept", transferId: 1, extra: true }).success).toBe(false);
    expect(nearbyControlPayloadSchema.safeParse({ type: "workspace-invite", inviteId: "00000000-0000-4000-8000-000000000001", secret: "a".repeat(43), workspaceName: "Private", role: "editor", expiresAt: new Date().toISOString(), extra: true }).success).toBe(false);
  });
});
