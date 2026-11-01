import { z } from "zod";
export * from "./crypto/index.js";

export const pingSchema = z.object({
  type: z.literal("ping"),
  ts: z.number(),
});

export const pongSchema = z.object({
  type: z.literal("pong"),
  ts: z.number(),
  serverTime: z.number(),
});

export const peerIdSchema = z.string().uuid();
export const workspaceIdSchema = z.string().uuid();
export const userIdSchema = z.string().uuid();
export const workspaceRoleSchema = z.enum(["owner", "editor", "viewer"]);

export const peerDirectoryEntrySchema = z.object({
  peerId: peerIdSchema,
  userId: userIdSchema,
  displayName: z.string().min(1).max(80),
  role: workspaceRoleSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const workspaceMemberDirectorySchema = z.object({
  userId: userIdSchema,
  displayName: z.string().min(1).max(80),
  role: workspaceRoleSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  publicKey: z.string().min(1),
});

export const authSignalSchema = z.object({
  type: z.literal("auth"),
  token: z.string().min(1),
});

export const offerSignalSchema = z.object({
  kind: z.enum(["offer", "answer"]),
  sdp: z.string(),
});

export const iceSignalSchema = z.object({
  kind: z.literal("ice"),
  candidate: z.object({
    candidate: z.string(),
    sdpMid: z.string().nullable().optional(),
    sdpMLineIndex: z.number().nullable().optional(),
    usernameFragment: z.string().nullable().optional(),
  }),
});

export const signalDataSchema = z.union([offerSignalSchema, iceSignalSchema]);

export const joinSchema = z.object({
  type: z.literal("join"),
  workspaceId: workspaceIdSchema,
  peerId: peerIdSchema,
});

export const leaveSchema = z.object({ type: z.literal("leave") });

export const relaySignalSchema = z.object({
  type: z.literal("signal"),
  to: peerIdSchema,
  data: signalDataSchema,
});

export const clientMessageSchema = z.union([
  authSignalSchema,
  pingSchema,
  joinSchema,
  leaveSchema,
  relaySignalSchema,
]);

export const joinedSchema = z.object({
  type: z.literal("joined"),
  peerId: peerIdSchema,
  workspaceId: workspaceIdSchema,
  peers: z.array(peerDirectoryEntrySchema),
});

export const peerJoinedSchema = z.object({
  type: z.literal("peer-joined"),
  peer: peerDirectoryEntrySchema,
});

export const peerLeftSchema = z.object({
  type: z.literal("peer-left"),
  peerId: peerIdSchema,
});

export const forwardedSignalSchema = z.object({
  type: z.literal("signal"),
  from: peerIdSchema,
  data: signalDataSchema,
});

export const authenticatedSchema = z.object({
  type: z.literal("authenticated"),
  userId: userIdSchema,
});

export const memberAddedSchema = z.object({
  type: z.literal("member-added"),
  member: workspaceMemberDirectorySchema,
});

export const memberRemovedSchema = z.object({
  type: z.literal("member-removed"),
  userId: userIdSchema,
});

export const roleChangedSchema = z.object({
  type: z.literal("role-changed"),
  userId: userIdSchema,
  role: z.enum(["editor", "viewer"]),
});

export const kickedSchema = z.object({
  type: z.literal("kicked"),
  workspaceId: workspaceIdSchema,
  message: z.string(),
});

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const serverMessageSchema = z.union([
  pongSchema,
  authenticatedSchema,
  joinedSchema,
  peerJoinedSchema,
  peerLeftSchema,
  forwardedSignalSchema,
  memberAddedSchema,
  memberRemovedSchema,
  roleChangedSchema,
  kickedSchema,
  errorMessageSchema,
]);

export const signalMessageSchema = z.union([
  clientMessageSchema,
  serverMessageSchema,
]);

export const chatMessageSchema = z.object({
  type: z.literal("chat"),
  text: z.string().max(4000),
  ts: z.number(),
});

export const MAX_FILE_SIZE = 500 * 1024 * 1024;
export const FILE_CHUNK_SIZE = 16 * 1024;

export const fileOfferSchema = z.object({
  type: z.literal("file-offer"),
  transferId: z.number().int().nonnegative().max(0xffffffff),
  sealed: z.string().min(1),
});
export const fileOfferPayloadSchema = z.object({
  name: z.string().min(1).max(1024),
  size: z.number().int().nonnegative(),
  mime: z.string().max(255),
  chunkSize: z.number().int().positive(),
  totalChunks: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  fileKey: z.string().min(1),
});
export const fileAcceptSchema = z.object({
  type: z.literal("file-accept"),
  transferId: z.number().int().nonnegative().max(0xffffffff),
});
export const fileRejectSchema = z.object({
  type: z.literal("file-reject"),
  transferId: z.number().int().nonnegative().max(0xffffffff),
  reason: z.string().max(1000),
});
export const fileCompleteSchema = z.object({
  type: z.literal("file-complete"),
  transferId: z.number().int().nonnegative().max(0xffffffff),
});
export const fileAckSchema = z.object({
  type: z.literal("file-ack"),
  transferId: z.number().int().nonnegative().max(0xffffffff),
  ok: z.boolean(),
  reason: z.string().max(1000).optional(),
});
export const fileCancelSchema = z.object({
  type: z.literal("file-cancel"),
  transferId: z.number().int().nonnegative().max(0xffffffff),
  reason: z.string().max(1000).optional(),
});
export const fileControlMessageSchema = z.discriminatedUnion("type", [
  fileOfferSchema,
  fileAcceptSchema,
  fileRejectSchema,
  fileCompleteSchema,
  fileAckSchema,
  fileCancelSchema,
]);
export const identityAlgorithmSchema = z.enum(["X25519", "P-256"]);
export const helloMessageSchema = z.object({
  type: z.literal("hello"),
  v: z.literal(1),
  alg: identityAlgorithmSchema,
  publicKey: z.string().min(1),
  nonce: z.string().min(1),
});
export const readyMessageSchema = z.object({
  type: z.literal("ready"),
  sealed: z.string().min(1),
});
export const readyPayloadSchema = z.object({
  type: z.literal("ready"),
  v: z.literal(1),
});
export const dataChannelMessageSchema = z.union([
  chatMessageSchema,
  helloMessageSchema,
  readyMessageSchema,
  fileControlMessageSchema,
]);

export type FileOfferMessage = z.infer<typeof fileOfferSchema>;
export type FileOfferPayload = z.infer<typeof fileOfferPayloadSchema>;
export type FileControlMessage = z.infer<typeof fileControlMessageSchema>;
export type DataChannelMessage = z.infer<typeof dataChannelMessageSchema>;
export type IdentityAlgorithm = z.infer<typeof identityAlgorithmSchema>;
export type HelloMessage = z.infer<typeof helloMessageSchema>;
export type ReadyMessage = z.infer<typeof readyMessageSchema>;

export interface ChunkTransform {
  encode(
    chunk: Uint8Array,
    ctx: { transferId: number; index: number },
  ): Promise<Uint8Array>;
  decode(
    data: Uint8Array,
    ctx: { transferId: number; index: number },
  ): Promise<Uint8Array>;
}

export const IdentityTransform: ChunkTransform = {
  async encode(chunk) {
    return chunk;
  },
  async decode(data) {
    return data;
  },
};

export function chunkCount(size: number, chunkSize = FILE_CHUNK_SIZE): number {
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0
  )
    throw new RangeError("Invalid file or chunk size");
  return Math.ceil(size / chunkSize);
}

export function packChunk(
  transferId: number,
  index: number,
  payload: Uint8Array,
): ArrayBuffer {
  for (const value of [transferId, index]) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff)
      throw new RangeError("Chunk header values must be uint32 integers");
  }
  const packed = new Uint8Array(8 + payload.byteLength);
  const view = new DataView(packed.buffer);
  view.setUint32(0, transferId, false);
  view.setUint32(4, index, false);
  packed.set(payload, 8);
  return packed.buffer;
}

export function unpackChunk(buf: ArrayBuffer): {
  transferId: number;
  index: number;
  payload: Uint8Array;
} {
  if (buf.byteLength < 8)
    throw new RangeError("Chunk buffer must contain an 8-byte header");
  const view = new DataView(buf);
  return {
    transferId: view.getUint32(0, false),
    index: view.getUint32(4, false),
    payload: new Uint8Array(buf, 8),
  };
}

export type PingMessage = z.infer<typeof pingSchema>;
export type PongMessage = z.infer<typeof pongSchema>;
export type JoinMessage = z.infer<typeof joinSchema>;
export type LeaveMessage = z.infer<typeof leaveSchema>;
export type SignalData = z.infer<typeof signalDataSchema>;
export type ClientSignalMessage = z.infer<typeof clientMessageSchema>;
export type ServerSignalMessage = z.infer<typeof serverMessageSchema>;
export type SignalMessage = z.infer<typeof signalMessageSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type PeerDirectoryEntry = z.infer<typeof peerDirectoryEntrySchema>;
export type WorkspaceMemberDirectory = z.infer<
  typeof workspaceMemberDirectorySchema
>;
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export type ParseMessageResult<T> =
  { success: true; data: T } | { success: false; error: string };

function parseJson(raw: string): ParseMessageResult<unknown> {
  try {
    return { success: true, data: JSON.parse(raw) as unknown };
  } catch {
    return { success: false, error: "Message must contain valid JSON" };
  }
}

function parseWithSchema<T>(
  raw: string,
  schema: z.ZodType<T>,
): ParseMessageResult<T> {
  try {
    const decoded = parseJson(raw);
    if (!decoded.success) return decoded;
    const parsed = schema.safeParse(decoded.data);
    if (!parsed.success) {
      return { success: false, error: "Message does not match the protocol" };
    }
    return { success: true, data: parsed.data };
  } catch {
    return { success: false, error: "Message could not be parsed" };
  }
}

export function parseClientMessage(
  raw: string,
): ParseMessageResult<ClientSignalMessage> {
  return parseWithSchema(raw, clientMessageSchema);
}

export function parseServerMessage(
  raw: string,
): ParseMessageResult<ServerSignalMessage> {
  return parseWithSchema(raw, serverMessageSchema);
}

export function parseMessage(raw: string): ParseMessageResult<SignalMessage> {
  return parseWithSchema(raw, signalMessageSchema);
}
