import { z } from "zod";
import { concatBytes, utf8 } from "../crypto/encoding.js";
import {
  MAX_FILES_PER_WORKSPACE,
  MAX_MANIFEST_SIZE,
  fileEntrySchema,
} from "./schemas.js";
import type { FileEntry } from "./types.js";

export const MAX_SYNC_PARTS = 64;
export const MAX_SYNC_PLAINTEXT_BYTES = 12_000;
export const MAX_SYNC_DELTA_ENTRIES = 20;
export const SYNC_REASSEMBLY_TIMEOUT_MS = 30_000;
export const MAX_SYNC_WIRE_BYTES = 16 * 1024;

const syncIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const requestIdSchema = z.string().uuid();

export const manifestFragmentSchema = z.object({
  type: z.literal("manifest"),
  syncId: syncIdSchema,
  partIndex: z
    .number()
    .int()
    .min(0)
    .max(MAX_SYNC_PARTS - 1),
  totalParts: z.number().int().min(1).max(MAX_SYNC_PARTS),
  entries: z.array(fileEntrySchema).max(MAX_FILES_PER_WORKSPACE),
});

export const deltaMessageSchema = z.object({
  type: z.literal("delta"),
  syncId: syncIdSchema,
  entries: z.array(fileEntrySchema).min(1).max(MAX_SYNC_DELTA_ENTRIES),
});

export const pullRequestSchema = z.object({
  type: z.literal("pull-request"),
  syncId: syncIdSchema,
  requestId: requestIdSchema,
  fileId: z.string().uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const pullDeniedSchema = z.object({
  type: z.literal("pull-denied"),
  syncId: syncIdSchema,
  requestId: requestIdSchema,
  reason: z.enum(["not-found", "hash-mismatch", "forbidden"]),
});

export const syncMessageTypeSchema = z.enum([
  "manifest",
  "delta",
  "pull-request",
  "pull-denied",
]);

export const syncHeaderSchema = z
  .object({
    v: z.literal(1),
    messageType: syncMessageTypeSchema,
    workspaceId: z.string().uuid(),
    syncId: syncIdSchema,
    partIndex: z
      .number()
      .int()
      .min(0)
      .max(MAX_SYNC_PARTS - 1),
    totalParts: z.number().int().min(1).max(MAX_SYNC_PARTS),
    seq: z.number().int().min(1).max(0xffffffff),
  })
  .strict()
  .refine((header) => header.partIndex < header.totalParts, {
    message: "Sync fragment index must be below its total part count",
    path: ["partIndex"],
  });

export const syncWireMessageSchema = z
  .object({
    type: z.literal("sync"),
    header: syncHeaderSchema,
    sealed: z.string().min(1),
  })
  .strict();

export type SyncHeader = z.infer<typeof syncHeaderSchema>;
export type SyncWireMessage = z.infer<typeof syncWireMessageSchema>;

export const syncPayloadSchema = z.discriminatedUnion("type", [
  manifestFragmentSchema,
  deltaMessageSchema,
  pullRequestSchema,
  pullDeniedSchema,
]);

export type ManifestFragment = z.infer<typeof manifestFragmentSchema>;
export type DeltaMessage = z.infer<typeof deltaMessageSchema>;
export type PullRequestMessage = z.infer<typeof pullRequestSchema>;
export type PullDeniedMessage = z.infer<typeof pullDeniedSchema>;
export type SyncPayload = z.infer<typeof syncPayloadSchema>;

function encodeUint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

export function buildSyncAad(
  header: SyncHeader,
  senderFingerprint: string,
  receiverFingerprint: string,
): Uint8Array {
  return concatBytes(
    utf8("zerocloud/v1/sync"),
    utf8(header.messageType),
    utf8(header.workspaceId),
    utf8(header.syncId),
    encodeUint32(header.partIndex),
    encodeUint32(header.totalParts),
    encodeUint32(header.seq),
    utf8(senderFingerprint),
    utf8(receiverFingerprint),
  );
}

export type ParsedSyncWire =
  | { ok: true; message: SyncWireMessage }
  | { ok: false; reason: "oversize" | "invalid" | "workspace" };

export function parseSyncWire(
  raw: string,
  workspaceId: string,
): ParsedSyncWire {
  if (raw.length > MAX_SYNC_WIRE_BYTES) {
    return { ok: false, reason: "oversize" };
  }
  if (utf8(raw).byteLength > MAX_SYNC_WIRE_BYTES) {
    return { ok: false, reason: "oversize" };
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const parsed = syncWireMessageSchema.safeParse(decoded);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  if (parsed.data.header.workspaceId !== workspaceId) {
    return { ok: false, reason: "workspace" };
  }
  return { ok: true, message: parsed.data };
}

export class SyncReplayGuard {
  private highestSeq = 0;
  private readonly manifestParts = new Map<
    string,
    { seq: number; totalParts: number; indexes: Set<number> }
  >();

  canAccept(header: SyncHeader): boolean {
    if (header.seq > this.highestSeq) return true;
    if (header.seq < this.highestSeq || header.messageType !== "manifest") {
      return false;
    }
    const manifest = this.manifestParts.get(header.syncId);
    return (
      manifest?.seq === header.seq &&
      manifest.totalParts === header.totalParts &&
      !manifest.indexes.has(header.partIndex)
    );
  }

  accept(header: SyncHeader): void {
    if (!this.canAccept(header))
      throw new Error("Sync message replay rejected");
    if (header.seq > this.highestSeq) {
      this.highestSeq = header.seq;
      this.manifestParts.clear();
    }
    if (header.messageType !== "manifest") return;
    const manifest = this.manifestParts.get(header.syncId) ?? {
      seq: header.seq,
      totalParts: header.totalParts,
      indexes: new Set<number>(),
    };
    manifest.indexes.add(header.partIndex);
    if (manifest.indexes.size === manifest.totalParts) {
      this.manifestParts.delete(header.syncId);
    } else {
      this.manifestParts.set(header.syncId, manifest);
    }
  }

  discardManifest(syncId: string): void {
    this.manifestParts.delete(syncId);
  }
}

export function createSyncId(
  randomBytes = crypto.getRandomValues(new Uint8Array(16)),
): string {
  if (randomBytes.length !== 16)
    throw new Error("A sync ID requires 16 random bytes");
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function fragmentSize(syncId: string, entries: FileEntry[]): number {
  return utf8(
    JSON.stringify({
      type: "manifest",
      syncId,
      partIndex: MAX_SYNC_PARTS - 1,
      totalParts: MAX_SYNC_PARTS,
      entries,
    }),
  ).byteLength;
}

export function fragmentManifest(
  entries: FileEntry[],
  syncId: string,
): ManifestFragment[] {
  if (entries.length > MAX_FILES_PER_WORKSPACE) {
    throw new Error("Manifest exceeds the 500 entry workspace limit");
  }
  const validEntries = entries.map((entry) => fileEntrySchema.parse(entry));
  if (utf8(JSON.stringify(validEntries)).byteLength > MAX_MANIFEST_SIZE) {
    throw new Error("Manifest exceeds the 1 MB size limit");
  }

  const groups: FileEntry[][] = [];
  let current: FileEntry[] = [];
  for (const entry of validEntries) {
    const candidate = [...current, entry];
    if (
      current.length > 0 &&
      fragmentSize(syncId, candidate) > MAX_SYNC_PLAINTEXT_BYTES
    ) {
      groups.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
    if (fragmentSize(syncId, current) > MAX_SYNC_PLAINTEXT_BYTES) {
      throw new Error("A file entry exceeds the sync fragment size limit");
    }
  }
  if (current.length || groups.length === 0) groups.push(current);
  if (groups.length > MAX_SYNC_PARTS) {
    throw new Error("Manifest requires more than 64 sync fragments");
  }

  const totalParts = groups.length;
  return groups.map((partEntries, partIndex) => {
    const fragment: ManifestFragment = {
      type: "manifest",
      syncId,
      partIndex,
      totalParts,
      entries: partEntries,
    };
    if (utf8(JSON.stringify(fragment)).byteLength > MAX_SYNC_PLAINTEXT_BYTES) {
      throw new Error("Manifest fragment exceeds 12,000 plaintext bytes");
    }
    return fragment;
  });
}

export function createDeltaMessages(entries: FileEntry[]): DeltaMessage[] {
  const validEntries = entries.map((entry) => fileEntrySchema.parse(entry));
  const batches: FileEntry[][] = [];
  let current: FileEntry[] = [];
  for (const entry of validEntries) {
    const candidate = [...current, entry];
    const candidateMessage = {
      type: "delta" as const,
      syncId: "00".repeat(16),
      entries: candidate,
    };
    if (
      current.length > 0 &&
      (candidate.length > MAX_SYNC_DELTA_ENTRIES ||
        utf8(JSON.stringify(candidateMessage)).byteLength >
          MAX_SYNC_PLAINTEXT_BYTES)
    ) {
      batches.push(current);
      current = [entry];
    } else {
      current = candidate;
    }
    if (
      current.length > MAX_SYNC_DELTA_ENTRIES ||
      utf8(
        JSON.stringify({
          type: "delta",
          syncId: "00".repeat(16),
          entries: current,
        }),
      ).byteLength > MAX_SYNC_PLAINTEXT_BYTES
    ) {
      throw new Error("A file entry exceeds the delta message size limit");
    }
  }
  if (current.length > 0) batches.push(current);
  return batches.map((batch) => ({
    type: "delta",
    syncId: createSyncId(),
    entries: batch,
  }));
}

export function assembleManifest(
  fragments: readonly ManifestFragment[],
): FileEntry[] {
  if (fragments.length === 0 || fragments.length > MAX_SYNC_PARTS) {
    throw new Error("Invalid manifest fragment count");
  }
  const first = fragments[0];
  if (!first) throw new Error("Manifest is missing its first fragment");
  if (fragments.length !== first.totalParts) {
    throw new Error("Manifest has missing fragments");
  }
  const ordered = [...fragments].sort((a, b) => a.partIndex - b.partIndex);
  const entries: FileEntry[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const fragment = ordered[index];
    if (
      !fragment ||
      fragment.syncId !== first.syncId ||
      fragment.totalParts !== first.totalParts ||
      fragment.partIndex !== index
    ) {
      throw new Error("Manifest fragments are duplicated or inconsistent");
    }
    entries.push(...fragment.entries);
  }
  if (entries.length > MAX_FILES_PER_WORKSPACE) {
    throw new Error("Manifest exceeds the 500 entry workspace limit");
  }
  if (utf8(JSON.stringify(entries)).byteLength > MAX_MANIFEST_SIZE) {
    throw new Error("Manifest exceeds the 1 MB size limit");
  }
  return entries;
}
