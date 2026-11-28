import { helloMessageSchema, nearbyControlEnvelopeSchema, readyMessageSchema } from "@zerocloud/shared";

const nearbyTypes = new Set(["hello", "ready", "nearby-control"]);
const nearbyControlTypes = new Set(["nearby-file-offer", "nearby-file-accept", "nearby-file-reject", "nearby-file-complete", "nearby-file-ack", "nearby-file-cancel", "workspace-invite", "invite-ack"]);
const workspaceTypes = new Set(["hello", "ready", "chat", "sync", "sync-file-offer", "file-offer", "file-accept", "file-reject", "file-complete", "file-ack", "file-cancel", "ws-proof", "stale-key"]);

export type RouterResult = { accepted: true; type: string } | { accepted: false; reason: "invalid" | "wrong-channel" };

export function routePeerMessage(channel: "zc-nearby" | "zc-data", value: unknown, onDrop?: () => void, openedNearbyControl = false): RouterResult {
  if (!value || typeof value !== "object" || !("type" in value) || typeof value.type !== "string") {
    onDrop?.(); return { accepted: false, reason: "invalid" };
  }
  const type = value.type;
  if (channel === "zc-nearby" && openedNearbyControl && nearbyControlTypes.has(type)) return { accepted: true, type };
  const allowed = channel === "zc-nearby" ? nearbyTypes : workspaceTypes;
  if (!allowed.has(type)) { onDrop?.(); return { accepted: false, reason: "wrong-channel" }; }
  if (type === "hello" && !helloMessageSchema.strict().safeParse(value).success) { onDrop?.(); return { accepted: false, reason: "invalid" }; }
  if (type === "ready" && !readyMessageSchema.strict().safeParse(value).success) { onDrop?.(); return { accepted: false, reason: "invalid" }; }
  if (type === "nearby-control" && !nearbyControlEnvelopeSchema.safeParse(value).success) { onDrop?.(); return { accepted: false, reason: "invalid" }; }
  return { accepted: true, type };
}
