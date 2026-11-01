import { describe, expect, it } from "vitest";
import {
  compareVersions,
  createLocalEntry,
  deleteLocalEntry,
  diffManifests,
  replaceLocalEntry,
  type FileEntry,
} from "./index.js";

const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const authorA = "1".repeat(64);
const authorB = "2".repeat(64);

function entry(overrides: Partial<FileEntry> = {}): FileEntry {
  return {
    fileId: "00000000-0000-4000-8000-000000000001",
    name: "report.txt",
    size: 10,
    sha256: hashA,
    lamport: 1,
    author: authorA,
    authorName: "Alice",
    modifiedAt: 100,
    deleted: false,
    ...overrides,
  };
}

const writerContext = {
  isWriter: (fingerprint: string) => fingerprint !== "f".repeat(64),
};

describe("compareVersions", () => {
  it("orders by Lamport clock, then author, and recognizes equality", () => {
    expect(compareVersions(entry({ lamport: 2 }), entry())).toBe(1);
    expect(compareVersions(entry({ author: authorB }), entry())).toBe(1);
    expect(compareVersions(entry(), entry())).toBe(0);
    expect(compareVersions(entry(), entry({ author: authorB }))).toBe(-1);
  });
});

describe("diffManifests", () => {
  it("pulls a newer live entry and adopts newer metadata for the same content", () => {
    const local = entry();
    const newer = entry({ lamport: 2, sha256: hashB });
    const sameContent = entry({ lamport: 3 });
    expect(diffManifests([local], [newer], writerContext).pull).toEqual([
      newer,
    ]);
    expect(diffManifests([local], [sameContent], writerContext).adopt).toEqual([
      sameContent,
    ]);
  });

  it("adopts a winning tombstone and lets a newer live version resurrect it", () => {
    const tombstone = entry({ lamport: 2, size: 0, sha256: "", deleted: true });
    const resurrected = entry({ lamport: 3 });
    expect(diffManifests([entry()], [tombstone], writerContext).adopt).toEqual([
      tombstone,
    ]);
    expect(
      diffManifests([tombstone], [resurrected], writerContext).pull,
    ).toEqual([resurrected]);
  });

  it("pulls unknown live entries, adopts unknown tombstones, and ignores local winners or ties", () => {
    const unknownLive = entry({
      fileId: "00000000-0000-4000-8000-000000000002",
    });
    const unknownDeleted = entry({
      fileId: "00000000-0000-4000-8000-000000000003",
      size: 0,
      sha256: "",
      deleted: true,
    });
    const result = diffManifests(
      [entry({ lamport: 5 })],
      [unknownLive, unknownDeleted, entry()],
      writerContext,
    );
    expect(result.pull).toEqual([unknownLive]);
    expect(result.adopt).toEqual([unknownDeleted]);
    expect(result.ignore).toEqual([entry()]);
  });

  it("rejects non-writers, invalid entries, and oversized manifests", () => {
    const forged = entry({ author: "f".repeat(64) });
    const invalid = { ...entry(), name: "../private" };
    expect(diffManifests([], [forged], writerContext).reject).toHaveLength(1);
    expect(
      diffManifests([], [invalid as FileEntry], writerContext).reject,
    ).toHaveLength(1);
    const oversized = Array.from({ length: 501 }, (_, index) =>
      entry({
        fileId: `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      }),
    );
    expect(diffManifests([], oversized, writerContext).reject).toHaveLength(
      501,
    );
  });
});

describe("local changes", () => {
  it("increments beyond the highest seen remote Lamport value", () => {
    const result = createLocalEntry(
      {
        ...entry({ lamport: 1 }),
        fileId: "00000000-0000-4000-8000-000000000004",
      },
      [entry({ lamport: 41 })],
    );
    expect(result.entry.lamport).toBe(42);
  });

  it("keeps the file identity for replacements and creates a tombstone for deletes", () => {
    const original = entry({ lamport: 41 });
    const replaced = replaceLocalEntry(
      original.fileId,
      {
        name: "new.txt",
        size: 20,
        sha256: hashB,
        author: authorB,
        authorName: "Bob",
        modifiedAt: 200,
      },
      [original],
    );
    expect(replaced.entry.fileId).toBe(original.fileId);
    expect(replaced.entry.lamport).toBe(42);
    const deleted = deleteLocalEntry(
      original.fileId,
      { author: authorA, authorName: "Alice", modifiedAt: 300 },
      [replaced.entry],
    );
    expect(deleted.entry).toMatchObject({
      fileId: original.fileId,
      size: 0,
      sha256: "",
      lamport: 43,
      author: authorA,
      authorName: "Alice",
      modifiedAt: 300,
      deleted: true,
    });
  });

  it("does not change adopted metadata", () => {
    const local = entry({ lamport: 2 });
    const adopted = entry({ lamport: 41, author: authorB, authorName: "Bob" });
    const result = diffManifests([local], [adopted], writerContext).adopt[0];
    expect(result).toEqual(adopted);
  });
});
