import { z } from "zod";
import { open, seal } from "./seal.js";
import { base64ToBytes, bytesToBase64, concatBytes, utf8 } from "./encoding.js";

export const nearbyControlTypeSchema = z.enum(["nearby-file-offer", "nearby-file-accept", "nearby-file-reject", "nearby-file-complete", "nearby-file-ack", "nearby-file-cancel", "workspace-invite", "invite-ack"]);
export const nearbyControlEnvelopeSchema = z.object({ type: z.literal("nearby-control"), v: z.literal(1), messageType: nearbyControlTypeSchema, seq: z.number().int().min(1).max(0xffffffff), sealed: z.string().min(1) }).strict();
export const MAX_NEARBY_CONTROL_BYTES = 4 * 1024;

export type NearbyControlType = z.infer<typeof nearbyControlTypeSchema>;
export type NearbyControlEnvelope = z.infer<typeof nearbyControlEnvelopeSchema>;

export type NearbyAadContext = { messageType: NearbyControlType; senderFingerprint: string; receiverFingerprint: string; seq: number };

export function buildNearbyAad(context: NearbyAadContext): Uint8Array {
  if (!Number.isInteger(context.seq) || context.seq < 1 || context.seq > 0xffffffff) throw new RangeError("Nearby sequence must be a positive uint32");
  const seq = new Uint8Array(4);
  new DataView(seq.buffer).setUint32(0, context.seq, false);
  return concatBytes(utf8("zerocloud/v1/nearby"), utf8(context.messageType), utf8(context.senderFingerprint), utf8(context.receiverFingerprint), seq);
}

export async function sealNearbyControl(sessionKey: CryptoKey, context: NearbyAadContext, payload: unknown): Promise<NearbyControlEnvelope> {
  const plaintext = utf8(JSON.stringify(payload));
  const ciphertext = await seal(sessionKey, plaintext, buildNearbyAad(context));
  if (ciphertext.byteLength > MAX_NEARBY_CONTROL_BYTES) throw new RangeError("Nearby control message exceeds 4 KiB");
  return { type: "nearby-control", v: 1, messageType: context.messageType, seq: context.seq, sealed: bytesToBase64(ciphertext) };
}

export class NearbyReplayGuard {
  private highest = 0;
  canAccept(seq: number): boolean { return Number.isInteger(seq) && seq > this.highest && seq <= 0xffffffff; }
  accept(seq: number): void { if (!this.canAccept(seq)) throw new Error("Nearby replay rejected"); this.highest = seq; }
  get highestAccepted(): number { return this.highest; }
}

export async function openNearbyControl<T>(sessionKey: CryptoKey, envelopeValue: unknown, senderFingerprint: string, receiverFingerprint: string, replay: NearbyReplayGuard, payloadSchema: z.ZodType<T>): Promise<T> {
  const envelope = nearbyControlEnvelopeSchema.parse(envelopeValue);
  if (!replay.canAccept(envelope.seq)) throw new Error("Nearby replay rejected");
  const sealedBytes = base64ToBytes(envelope.sealed);
  if (sealedBytes.byteLength > MAX_NEARBY_CONTROL_BYTES) throw new RangeError("Nearby control message exceeds 4 KiB");
  const plaintext = await open(sessionKey, sealedBytes, buildNearbyAad({ messageType: envelope.messageType, senderFingerprint, receiverFingerprint, seq: envelope.seq }));
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(plaintext)) as unknown; } catch { throw new Error("Nearby control payload is invalid JSON"); }
  const payload = payloadSchema.parse(decoded);
  if (!payload || typeof payload !== "object" || !("type" in payload) || payload.type !== envelope.messageType) throw new Error("Nearby control type does not match authenticated header");
  replay.accept(envelope.seq);
  return payload;
}
