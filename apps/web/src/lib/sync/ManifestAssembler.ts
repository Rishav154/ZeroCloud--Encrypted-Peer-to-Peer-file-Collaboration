import {
  assembleManifest,
  MAX_MANIFEST_SIZE,
  MAX_SYNC_PARTS,
  SYNC_REASSEMBLY_TIMEOUT_MS,
  type FileEntry,
  type ManifestFragment,
} from "@zerocloud/shared";

type Assembly = {
  totalParts: number;
  parts: Map<number, ManifestFragment>;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
};

export type ManifestAddResult =
  | { status: "pending" }
  | { status: "duplicate" | "stale" }
  | { status: "complete"; entries: FileEntry[] };

export class ManifestAssembler {
  private readonly assemblies = new Map<string, Assembly>();
  private readonly completedByPeer = new Map<string, Set<string>>();

  add(peerId: string, fragment: ManifestFragment): ManifestAddResult {
    if (
      fragment.totalParts > MAX_SYNC_PARTS ||
      fragment.partIndex >= fragment.totalParts
    ) {
      throw new Error("Manifest fragment count or index exceeds limits");
    }
    const key = `${peerId}:${fragment.syncId}`;
    if (this.completedByPeer.get(peerId)?.has(fragment.syncId)) {
      return { status: "stale" };
    }
    let assembly = this.assemblies.get(key);
    if (!assembly) {
      const timer = setTimeout(
        () => this.discard(peerId, fragment.syncId),
        SYNC_REASSEMBLY_TIMEOUT_MS,
      );
      assembly = {
        totalParts: fragment.totalParts,
        parts: new Map(),
        bytes: 0,
        timer,
      };
      this.assemblies.set(key, assembly);
    }
    if (assembly.totalParts !== fragment.totalParts) {
      this.discard(peerId, fragment.syncId);
      throw new Error("Manifest fragments disagree about the part count");
    }
    if (assembly.parts.has(fragment.partIndex)) {
      return { status: "duplicate" };
    }
    assembly.bytes += new TextEncoder().encode(
      JSON.stringify(fragment),
    ).byteLength;
    if (
      assembly.bytes > MAX_MANIFEST_SIZE ||
      assembly.parts.size >= MAX_SYNC_PARTS
    ) {
      this.discard(peerId, fragment.syncId);
      throw new Error("Manifest exceeds reassembly limits");
    }
    assembly.parts.set(fragment.partIndex, fragment);
    if (assembly.parts.size !== assembly.totalParts)
      return { status: "pending" };

    try {
      const entries = assembleManifest([...assembly.parts.values()]);
      this.discard(peerId, fragment.syncId);
      this.markCompleted(peerId, fragment.syncId);
      return { status: "complete", entries };
    } catch (error) {
      this.discard(peerId, fragment.syncId);
      throw error;
    }
  }

  discard(peerId: string, syncId: string): void {
    const key = `${peerId}:${syncId}`;
    const assembly = this.assemblies.get(key);
    if (!assembly) return;
    clearTimeout(assembly.timer);
    this.assemblies.delete(key);
  }

  discardPeer(peerId: string): void {
    for (const key of this.assemblies.keys()) {
      if (!key.startsWith(`${peerId}:`)) continue;
      const syncId = key.slice(peerId.length + 1);
      this.discard(peerId, syncId);
    }
    this.completedByPeer.delete(peerId);
  }

  destroy(): void {
    for (const assembly of this.assemblies.values())
      clearTimeout(assembly.timer);
    this.assemblies.clear();
    this.completedByPeer.clear();
  }

  private markCompleted(peerId: string, syncId: string): void {
    const ids = this.completedByPeer.get(peerId) ?? new Set<string>();
    ids.add(syncId);
    while (ids.size > 128) {
      const oldest = ids.values().next().value as string | undefined;
      if (!oldest) break;
      ids.delete(oldest);
    }
    this.completedByPeer.set(peerId, ids);
  }
}
