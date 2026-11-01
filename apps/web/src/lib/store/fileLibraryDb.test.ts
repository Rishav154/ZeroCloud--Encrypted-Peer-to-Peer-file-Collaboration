import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  closeFileLibraryForTests,
  adoptRemoteEntry,
  commitPulledFile,
  deleteLocalFile,
  readBlob,
  readLibrary,
  saveLocalFile,
} from "./fileLibraryDb";

const workspaceId = "00000000-0000-4000-8000-000000000010";
const fileId = "00000000-0000-4000-8000-000000000011";
const fingerprint = "a".repeat(64);

async function metadata(file: Blob, id = fileId, name = "notes.txt") {
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return {
    fileId: id,
    name,
    size: file.size,
    sha256,
    author: fingerprint,
    authorName: "Test user",
    modifiedAt: Date.now(),
  };
}

async function resetDatabase(): Promise<void> {
  closeFileLibraryForTests();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase("zerocloud-file-library");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Database deletion was blocked"));
  });
}

afterEach(async () => resetDatabase());

describe("IndexedDB file library", () => {
  it("writes and reads entries and blobs across library reads", async () => {
    const blob = new Blob(["persisted content"]);
    const entry = await saveLocalFile({
      workspaceId,
      role: "owner",
      mode: "create",
      metadata: await metadata(blob),
      blob,
    });
    expect((await readLibrary(workspaceId)).items).toEqual([
      { entry, status: "present" },
    ]);
    expect(
      await (await readBlob(workspaceId, fileId, entry.sha256))?.text(),
    ).toBe("persisted content");
  });

  it("keeps the previous blob and entry when a replacement transaction aborts", async () => {
    const original = new Blob(["old version"]);
    const originalEntry = await saveLocalFile({
      workspaceId,
      role: "editor",
      mode: "create",
      metadata: await metadata(original),
      blob: original,
    });
    const replacement = new Blob(["new and longer version"]);
    await expect(
      saveLocalFile(
        {
          workspaceId,
          role: "editor",
          mode: "replace",
          metadata: await metadata(replacement),
          blob: replacement,
        },
        {
          afterBlobPut: () => {
            throw new DOMException(
              "simulated quota failure",
              "QuotaExceededError",
            );
          },
        },
      ),
    ).rejects.toThrow("Browser storage is full");
    expect((await readLibrary(workspaceId)).items[0]).toEqual({
      entry: originalEntry,
      status: "present",
    });
    expect(
      await (await readBlob(workspaceId, fileId, originalEntry.sha256))?.text(),
    ).toBe("old version");
  });

  it("refuses viewer writes and leaves the library empty", async () => {
    const blob = new Blob(["no write"]);
    await expect(
      saveLocalFile({
        workspaceId,
        role: "viewer",
        mode: "create",
        metadata: await metadata(blob),
        blob,
      }),
    ).rejects.toThrow("Viewers cannot change");
    expect((await readLibrary(workspaceId)).items).toEqual([]);
  });

  it("commits deletes as tombstones and removes the local blob", async () => {
    const blob = new Blob(["to delete"]);
    await saveLocalFile({
      workspaceId,
      role: "owner",
      mode: "create",
      metadata: await metadata(blob),
      blob,
    });
    const tombstone = await deleteLocalFile(workspaceId, fileId, "owner", {
      author: fingerprint,
      authorName: "Test user",
      modifiedAt: Date.now(),
    });
    expect((await readLibrary(workspaceId)).items).toEqual([
      { entry: tombstone, status: "tombstone" },
    ]);
    expect(await readBlob(workspaceId, fileId, tombstone.sha256)).toBeNull();
  });

  it("adopts the remote version metadata without re-stamping its author or clock", async () => {
    const blob = new Blob(["same content"]);
    const local = await saveLocalFile({
      workspaceId,
      role: "owner",
      mode: "create",
      metadata: await metadata(blob),
      blob,
    });
    const remote = {
      ...local,
      lamport: 41,
      author: "b".repeat(64),
      authorName: "Remote editor",
      modifiedAt: 123,
    };
    await adoptRemoteEntry(workspaceId, remote);
    const library = await readLibrary(workspaceId);
    expect(library.items[0]).toEqual({ entry: remote, status: "present" });
    expect(library.lamport).toBe(41);
  });

  it("commits a pulled blob with its advertised entry only when the hash matches", async () => {
    const blob = new Blob(["peer payload"]);
    const remote = await metadata(blob);
    await expect(
      commitPulledFile(
        workspaceId,
        { ...remote, lamport: 1, deleted: false },
        new Blob(["wrong content"]),
      ),
    ).rejects.toThrow("does not match its entry");
    expect((await readLibrary(workspaceId)).items).toEqual([]);
    await commitPulledFile(
      workspaceId,
      { ...remote, lamport: 1, deleted: false },
      blob,
    );
    expect((await readLibrary(workspaceId)).items[0]?.status).toBe("present");
  });
});
