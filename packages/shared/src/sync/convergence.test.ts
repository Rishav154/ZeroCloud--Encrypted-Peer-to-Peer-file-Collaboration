import { describe, expect, it } from "vitest";
import {
  compareVersions,
  createLocalEntry,
  deleteLocalEntry,
  diffManifests,
  replaceLocalEntry,
  type FileEntry,
} from "./index.js";

type Peer = {
  entries: Map<string, FileEntry>;
  highWater: number;
  writes: number;
};

const writers = ["1", "2", "3"].map((digit) => digit.repeat(64));
const viewerFingerprint = "f".repeat(64);
const writerContext = {
  isWriter: (fingerprint: string) => writers.includes(fingerprint),
};

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function fileId(counter: number): string {
  return `00000000-0000-4000-8000-${counter.toString().padStart(12, "0")}`;
}

function exchange(target: Peer, remote: Peer): boolean {
  let changed = false;
  const diff = diffManifests(
    [...target.entries.values()],
    [...remote.entries.values()],
    writerContext,
  );
  for (const incoming of [...diff.pull, ...diff.adopt]) {
    const existing = target.entries.get(incoming.fileId);
    if (!existing || compareVersions(incoming, existing) > 0) {
      target.entries.set(incoming.fileId, incoming);
      target.highWater = Math.max(target.highWater, incoming.lamport);
      changed = true;
    }
  }
  return changed;
}

function localChange(peer: Peer, writer: number, random: () => number): void {
  const live = [...peer.entries.values()].filter((entry) => !entry.deleted);
  const shouldCreate = live.length === 0 || random() < 0.35;
  const author = writers[writer]!;
  const modifiedAt = Math.floor(random() * 10_000_000);
  const hash = random() < 0.5 ? "a".repeat(64) : "b".repeat(64);
  if (shouldCreate) {
    const id = fileId(10_000 + writer * 10_000 + peer.writes);
    const change = createLocalEntry(
      {
        fileId: id,
        name: `file-${id.slice(-4)}.txt`,
        size: 1,
        sha256: hash,
        author,
        authorName: `Writer ${writer}`,
        modifiedAt,
      },
      [...peer.entries.values()],
      peer.highWater,
    );
    peer.entries.set(change.entry.fileId, change.entry);
    peer.highWater = change.lamport;
  } else {
    const selected = live[Math.floor(random() * live.length)]!;
    const change =
      random() < 0.25
        ? deleteLocalEntry(
            selected.fileId,
            { author, authorName: `Writer ${writer}`, modifiedAt },
            [...peer.entries.values()],
            peer.highWater,
          )
        : replaceLocalEntry(
            selected.fileId,
            {
              name: selected.name,
              size: 1,
              sha256: hash,
              author,
              authorName: `Writer ${writer}`,
              modifiedAt,
            },
            [...peer.entries.values()],
            peer.highWater,
          );
    peer.entries.set(change.entry.fileId, change.entry);
    peer.highWater = change.lamport;
  }
  peer.writes += 1;
}

describe("manifest convergence", () => {
  it("converges four peers over 200 deterministic operation seeds", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const random = seededRandom(seed);
      const peers: Peer[] = Array.from({ length: 4 }, () => ({
        entries: new Map(),
        highWater: 1,
        writes: 0,
      }));
      const initial = [1, 2].map(
        (value) =>
          ({
            fileId: fileId(value),
            name: `base-${value}.txt`,
            size: 1,
            sha256: "a".repeat(64),
            lamport: 1,
            author: writers[0]!,
            authorName: "Owner",
            modifiedAt: 1,
            deleted: false,
          }) satisfies FileEntry,
      );
      for (const peer of peers) {
        for (const entry of initial) peer.entries.set(entry.fileId, entry);
      }

      for (let operation = 0; operation < 75; operation += 1) {
        const writer = Math.floor(random() * writers.length);
        localChange(peers[writer]!, writer, random);
      }

      for (let exchangeIndex = 0; exchangeIndex < 160; exchangeIndex += 1) {
        const first = Math.floor(random() * peers.length);
        let second = Math.floor(random() * peers.length);
        if (second === first) second = (second + 1) % peers.length;
        exchange(peers[first]!, peers[second]!);
        exchange(peers[second]!, peers[first]!);
      }

      for (let round = 0; round < peers.length; round += 1) {
        for (const target of peers) {
          for (const remote of peers) {
            if (target !== remote) exchange(target, remote);
          }
        }
      }

      const expected = [...peers[0]!.entries.values()].sort((a, b) =>
        a.fileId.localeCompare(b.fileId),
      );
      for (const peer of peers) {
        const actual = [...peer.entries.values()].sort((a, b) =>
          a.fileId.localeCompare(b.fileId),
        );
        expect(actual, `seed ${seed}`).toEqual(expected);
        expect(
          actual.every((entry) => entry.author !== viewerFingerprint),
        ).toBe(true);
      }
    }
  }, 10_000);
});
