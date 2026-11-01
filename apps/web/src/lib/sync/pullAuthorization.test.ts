import { describe, expect, it } from "vitest";
import { authorizePullRequest } from "./pullAuthorization";
import type { FileEntry } from "@zerocloud/shared";

const liveEntry: FileEntry = {
  fileId: "00000000-0000-4000-8000-000000000012",
  name: "file.txt",
  size: 10,
  sha256: "a".repeat(64),
  lamport: 1,
  author: "1".repeat(64),
  authorName: "Owner",
  modifiedAt: 1,
  deleted: false,
};

describe("authorizePullRequest", () => {
  it("denies unknown peers and permits members with the exact stored hash, including viewers", () => {
    expect(
      authorizePullRequest(null, liveEntry, liveEntry.sha256, liveEntry.sha256),
    ).toBe("forbidden");
    expect(
      authorizePullRequest(
        "viewer",
        liveEntry,
        liveEntry.sha256,
        liveEntry.sha256,
      ),
    ).toBe("allowed");
    expect(
      authorizePullRequest(
        "editor",
        liveEntry,
        liveEntry.sha256,
        liveEntry.sha256,
      ),
    ).toBe("allowed");
  });

  it("distinguishes absent files and hash mismatches", () => {
    expect(
      authorizePullRequest("editor", undefined, null, liveEntry.sha256),
    ).toBe("not-found");
    expect(
      authorizePullRequest("editor", liveEntry, null, liveEntry.sha256),
    ).toBe("not-found");
    expect(
      authorizePullRequest(
        "editor",
        liveEntry,
        liveEntry.sha256,
        "b".repeat(64),
      ),
    ).toBe("hash-mismatch");
    expect(
      authorizePullRequest(
        "editor",
        liveEntry,
        "b".repeat(64),
        liveEntry.sha256,
      ),
    ).toBe("hash-mismatch");
  });
});
