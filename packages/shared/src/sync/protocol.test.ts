import { describe, expect, it } from "vitest";
import { open, seal } from "../crypto/seal.js";
import {
  assembleManifest,
  buildSyncAad,
  createSyncId,
  fragmentManifest,
  MAX_SYNC_WIRE_BYTES,
  manifestFragmentSchema,
  MAX_SYNC_PARTS,
  MAX_SYNC_PLAINTEXT_BYTES,
  parseSyncWire,
  SyncReplayGuard,
  syncHeaderSchema,
  syncWireMessageSchema,
  type FileEntry,
  type SyncHeader,
} from "./index.js";

function entry(index: number): FileEntry {
  return {
    fileId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    name: `document-${index.toString().padStart(4, "0")}-${"n".repeat(210)}.txt`,
    size: index,
    sha256: "a".repeat(64),
    lamport: index + 1,
    author: "1".repeat(64),
    authorName: "Workspace editor",
    modifiedAt: 1000 + index,
    deleted: false,
  };
}

describe("manifest fragmentation", () => {
  it("fragments valid entries below the plaintext limit and reassembles in index order", () => {
    const entries = Array.from({ length: 500 }, (_, index) => entry(index + 1));
    const syncId = "a1".repeat(16);
    const fragments = fragmentManifest(entries, syncId);
    expect(fragments.length).toBeGreaterThan(1);
    expect(fragments.length).toBeLessThanOrEqual(MAX_SYNC_PARTS);
    expect(
      fragments.every(
        (fragment) =>
          new TextEncoder().encode(JSON.stringify(fragment)).byteLength <=
          MAX_SYNC_PLAINTEXT_BYTES,
      ),
    ).toBe(true);
    expect(assembleManifest([...fragments].reverse())).toEqual(entries);
  });

  it("rejects excess fragment counts, duplicate indexes, and inconsistent sync IDs", () => {
    const fragments = fragmentManifest(
      Array.from({ length: 500 }, (_, index) => entry(index + 1)),
      "b2".repeat(16),
    );
    expect(
      manifestFragmentSchema.safeParse({
        ...fragments[0],
        totalParts: MAX_SYNC_PARTS + 1,
      }).success,
    ).toBe(false);
    expect(() =>
      assembleManifest([fragments[0]!, fragments[0]!, ...fragments.slice(2)]),
    ).toThrow("duplicated or inconsistent");
    const anotherSync = fragmentManifest(
      Array.from({ length: 500 }, (_, index) => entry(index + 1)),
      "c3".repeat(16),
    );
    expect(() =>
      assembleManifest([fragments[0]!, ...anotherSync.slice(1)]),
    ).toThrow("duplicated or inconsistent");
  });

  it("creates 16-byte random IDs encoded as lowercase hex", () => {
    expect(createSyncId(new Uint8Array(16).fill(0xab))).toBe("ab".repeat(16));
    expect(() => createSyncId(new Uint8Array(15))).toThrow("16 random bytes");
  });
});

const baseHeader: SyncHeader = {
  v: 1,
  messageType: "manifest",
  workspaceId: "00000000-0000-4000-8000-000000000099",
  syncId: "d4".repeat(16),
  partIndex: 0,
  totalParts: 1,
  seq: 1,
};
const senderFingerprint = "1".repeat(64);
const receiverFingerprint = "2".repeat(64);

describe("sync AAD and envelope checks", () => {
  it("authenticates each dynamic header value and the peer fingerprints", async () => {
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const plaintext = new TextEncoder().encode("authenticated sync body");
    const sealed = await seal(
      key,
      plaintext,
      buildSyncAad(baseHeader, senderFingerprint, receiverFingerprint),
    );
    const mutations: SyncHeader[] = [
      { ...baseHeader, messageType: "delta" },
      { ...baseHeader, workspaceId: "00000000-0000-4000-8000-000000000098" },
      { ...baseHeader, syncId: "e5".repeat(16) },
      { ...baseHeader, partIndex: 1, totalParts: 2 },
      { ...baseHeader, totalParts: 2 },
      { ...baseHeader, seq: 2 },
    ];
    for (const mutated of mutations) {
      await expect(
        open(
          key,
          sealed,
          buildSyncAad(mutated, senderFingerprint, receiverFingerprint),
        ),
      ).rejects.toThrow();
    }
    await expect(
      open(
        key,
        sealed,
        buildSyncAad(baseHeader, receiverFingerprint, senderFingerprint),
      ),
    ).rejects.toThrow();
  });

  it("rejects replayed and lower sequence numbers while allowing distinct manifest parts", () => {
    const guard = new SyncReplayGuard();
    const firstPart = { ...baseHeader, totalParts: 2 };
    const secondPart = { ...firstPart, partIndex: 1 };
    expect(guard.canAccept(firstPart)).toBe(true);
    guard.accept(firstPart);
    expect(guard.canAccept(secondPart)).toBe(true);
    guard.accept(secondPart);
    expect(guard.canAccept(firstPart)).toBe(false);
    const next = {
      ...baseHeader,
      messageType: "delta" as const,
      syncId: "f6".repeat(16),
      seq: 2,
    };
    expect(guard.canAccept(next)).toBe(true);
    guard.accept(next);
    expect(guard.canAccept({ ...next, syncId: "a7".repeat(16), seq: 1 })).toBe(
      false,
    );
  });

  it("rejects cross-connection replay, extra header keys, wrong workspaces, and oversized wire data", async () => {
    const firstKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const otherConnectionKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const sealed = await seal(
      firstKey,
      new TextEncoder().encode("peer data"),
      buildSyncAad(baseHeader, senderFingerprint, receiverFingerprint),
    );
    await expect(
      open(
        otherConnectionKey,
        sealed,
        buildSyncAad(baseHeader, senderFingerprint, receiverFingerprint),
      ),
    ).rejects.toThrow();

    expect(
      syncHeaderSchema.safeParse({ ...baseHeader, extra: "nope" }).success,
    ).toBe(false);
    expect(
      syncWireMessageSchema.safeParse({
        type: "sync",
        header: baseHeader,
        sealed: "AA==",
        extra: "nope",
      }).success,
    ).toBe(false);
    const wrongWorkspace = parseSyncWire(
      JSON.stringify({ type: "sync", header: baseHeader, sealed: "AA==" }),
      "00000000-0000-4000-8000-000000000098",
    );
    expect(wrongWorkspace).toEqual({ ok: false, reason: "workspace" });
    const oversize = parseSyncWire(
      JSON.stringify({
        type: "sync",
        header: baseHeader,
        sealed: "a".repeat(MAX_SYNC_WIRE_BYTES),
      }),
      baseHeader.workspaceId,
    );
    expect(oversize).toEqual({ ok: false, reason: "oversize" });
  });
});
