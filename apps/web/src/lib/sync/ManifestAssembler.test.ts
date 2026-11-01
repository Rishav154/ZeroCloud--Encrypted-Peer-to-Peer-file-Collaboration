import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileEntry, ManifestFragment } from "@zerocloud/shared";
import { ManifestAssembler } from "./ManifestAssembler";

const entry = (id: number): FileEntry => ({
  fileId: `00000000-0000-4000-8000-${id.toString().padStart(12, "0")}`,
  name: `file-${id}.txt`,
  size: 0,
  sha256: "a".repeat(64),
  lamport: id,
  author: "1".repeat(64),
  authorName: "Editor",
  modifiedAt: id,
  deleted: false,
});

const fragments = (): ManifestFragment[] => [
  {
    type: "manifest",
    syncId: "a1".repeat(16),
    partIndex: 0,
    totalParts: 2,
    entries: [entry(1)],
  },
  {
    type: "manifest",
    syncId: "a1".repeat(16),
    partIndex: 1,
    totalParts: 2,
    entries: [entry(2)],
  },
];

afterEach(() => vi.useRealTimers());

describe("ManifestAssembler", () => {
  it("reassembles out-of-order parts, ignores duplicates, and remembers completed IDs", () => {
    const assembler = new ManifestAssembler();
    const [first, second] = fragments();
    expect(assembler.add("peer", second!)).toEqual({ status: "pending" });
    expect(assembler.add("peer", second!)).toEqual({ status: "duplicate" });
    expect(assembler.add("peer", first!)).toEqual({
      status: "complete",
      entries: [entry(1), entry(2)],
    });
    expect(assembler.add("peer", first!)).toEqual({ status: "stale" });
    assembler.destroy();
  });

  it("discards inconsistent and out-of-range fragments", () => {
    const assembler = new ManifestAssembler();
    const [first, second] = fragments();
    expect(() => assembler.add("peer", { ...first!, totalParts: 129 })).toThrow(
      "exceeds limits",
    );
    assembler.add("peer", first!);
    expect(() => assembler.add("peer", { ...second!, totalParts: 3 })).toThrow(
      "disagree",
    );
    assembler.destroy();
  });

  it("expires incomplete manifests after 30 seconds and allows a fresh assembly", () => {
    vi.useFakeTimers();
    const assembler = new ManifestAssembler();
    const [first, second] = fragments();
    assembler.add("peer", first!);
    vi.advanceTimersByTime(30_000);
    expect(assembler.add("peer", second!)).toEqual({ status: "pending" });
    expect(assembler.add("peer", first!)).toMatchObject({ status: "complete" });
    assembler.destroy();
  });
});
