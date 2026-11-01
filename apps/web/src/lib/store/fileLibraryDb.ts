import {
  createLocalEntry,
  compareVersions,
  deleteLocalEntry,
  fileEntrySchema,
  MAX_FILES_PER_WORKSPACE,
  replaceLocalEntry,
  type FileEntry,
  type LocalFileMetadata,
  type WorkspaceRole,
} from "@zerocloud/shared";

const DATABASE_NAME = "zerocloud-file-library";
const DATABASE_VERSION = 1;
const ENTRY_STORE = "entries";
const BLOB_STORE = "blobs";
const META_STORE = "meta";

type StoredEntry = FileEntry & { workspaceId: string };
type StoredBlob = {
  workspaceId: string;
  fileId: string;
  sha256: string;
  blob: Blob;
};
type StoredMeta = { workspaceId: string; lamport: number };

export type LibraryItem = {
  entry: FileEntry;
  status: "present" | "missing" | "tombstone";
};

export type LibrarySnapshot = {
  items: LibraryItem[];
  lamport: number;
};

export type SaveFileInput = {
  workspaceId: string;
  role: WorkspaceRole;
  mode: "create" | "replace";
  metadata: LocalFileMetadata;
  blob: Blob;
};

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("This browser does not support IndexedDB"));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore(ENTRY_STORE, {
        keyPath: ["workspaceId", "fileId"],
      });
      database.createObjectStore(BLOB_STORE, {
        keyPath: ["workspaceId", "fileId"],
      });
      database.createObjectStore(META_STORE, { keyPath: "workspaceId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(new Error("Could not open the local file library"));
    };
    request.onblocked = () => {
      databasePromise = null;
      reject(new Error("The local file library is blocked by another tab"));
    };
  });
  return databasePromise;
}

function asEntry(record: StoredEntry): FileEntry {
  const { workspaceId, ...entry } = record;
  void workspaceId;
  return entry;
}

function isQuotaError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "QuotaExceededError" ||
      error.name === "NS_ERROR_DOM_QUOTA_REACHED")
  );
}

function readableStoreError(error: unknown): Error {
  if (isQuotaError(error)) {
    return new Error("Browser storage is full. Free space and try again.");
  }
  return error instanceof Error
    ? error
    : new Error("Could not update the local file library");
}

export async function readLibrary(
  workspaceId: string,
): Promise<LibrarySnapshot> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      [ENTRY_STORE, BLOB_STORE, META_STORE],
      "readonly",
    );
    const entriesRequest = transaction
      .objectStore(ENTRY_STORE)
      .getAll() as IDBRequest<StoredEntry[]>;
    const blobsRequest = transaction
      .objectStore(BLOB_STORE)
      .getAll() as IDBRequest<StoredBlob[]>;
    const metaRequest = transaction
      .objectStore(META_STORE)
      .get(workspaceId) as IDBRequest<StoredMeta | undefined>;
    let records: StoredEntry[] | null = null;
    let blobs: StoredBlob[] | null = null;
    let meta: StoredMeta | undefined;
    let metaReady = false;

    const finish = (): void => {
      if (!records || !blobs || !metaReady) return;
      const blobHashes = new Map(
        blobs
          .filter((record) => record.workspaceId === workspaceId)
          .map((record) => [record.fileId, record.sha256]),
      );
      const items = records
        .filter((record) => record.workspaceId === workspaceId)
        .map((record): LibraryItem => {
          const entry = asEntry(record);
          if (entry.deleted) return { entry, status: "tombstone" };
          return {
            entry,
            status:
              blobHashes.get(entry.fileId) === entry.sha256
                ? "present"
                : "missing",
          };
        });
      resolve({ items, lamport: meta?.lamport ?? 0 });
    };

    entriesRequest.onsuccess = () => {
      records = entriesRequest.result;
      finish();
    };
    blobsRequest.onsuccess = () => {
      blobs = blobsRequest.result;
      finish();
    };
    metaRequest.onsuccess = () => {
      meta = metaRequest.result;
      metaReady = true;
      finish();
    };
    transaction.onabort = () => reject(readableStoreError(transaction.error));
    transaction.onerror = () => reject(readableStoreError(transaction.error));
  });
}

export async function readBlob(
  workspaceId: string,
  fileId: string,
  expectedHash: string,
): Promise<Blob | null> {
  const record = await readStoredBlob(workspaceId, fileId);
  return record?.sha256 === expectedHash ? record.blob : null;
}

export async function readStoredBlob(
  workspaceId: string,
  fileId: string,
): Promise<{ sha256: string; blob: Blob } | null> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(BLOB_STORE, "readonly");
    const request = transaction
      .objectStore(BLOB_STORE)
      .get([workspaceId, fileId]) as IDBRequest<StoredBlob | undefined>;
    request.onsuccess = () => {
      const record = request.result;
      resolve(record ? { sha256: record.sha256, blob: record.blob } : null);
    };
    transaction.onabort = () => reject(readableStoreError(transaction.error));
    transaction.onerror = () => reject(readableStoreError(transaction.error));
  });
}

export async function saveLocalFile(
  input: SaveFileInput,
  hooks: { afterBlobPut?: () => void } = {},
): Promise<FileEntry> {
  if (input.role === "viewer")
    throw new Error("Viewers cannot change workspace files");
  if (input.blob.size !== input.metadata.size) {
    throw new Error(
      "The selected file size changed while it was being prepared",
    );
  }
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      [ENTRY_STORE, BLOB_STORE, META_STORE],
      "readwrite",
    );
    const entryStore = transaction.objectStore(ENTRY_STORE);
    const blobStore = transaction.objectStore(BLOB_STORE);
    const metaStore = transaction.objectStore(META_STORE);
    const entriesRequest = entryStore.getAll() as IDBRequest<StoredEntry[]>;
    const metaRequest = metaStore.get(input.workspaceId) as IDBRequest<
      StoredMeta | undefined
    >;
    let records: StoredEntry[] | null = null;
    let meta: StoredMeta | undefined;
    let metaReady = false;
    let result: FileEntry | null = null;
    let failure: Error | null = null;
    let committed = false;

    const abort = (error: unknown): void => {
      failure = readableStoreError(error);
      try {
        transaction.abort();
      } catch {
        reject(failure);
      }
    };

    const commit = (): void => {
      if (!records || !metaReady || result || failure) return;
      try {
        const workspaceEntries = records
          .filter((record) => record.workspaceId === input.workspaceId)
          .map(asEntry);
        const highWaterMark = meta?.lamport ?? 0;
        if (
          input.mode === "create" &&
          workspaceEntries.length >= MAX_FILES_PER_WORKSPACE
        ) {
          throw new Error("This workspace has reached its 500 file limit");
        }

        const change =
          input.mode === "create"
            ? createLocalEntry(input.metadata, workspaceEntries, highWaterMark)
            : replaceLocalEntry(
                input.metadata.fileId,
                {
                  name: input.metadata.name,
                  size: input.metadata.size,
                  sha256: input.metadata.sha256,
                  author: input.metadata.author,
                  authorName: input.metadata.authorName,
                  modifiedAt: input.metadata.modifiedAt,
                },
                workspaceEntries,
                highWaterMark,
              );

        // Blob first, then metadata; one transaction preserves the previous pair on abort.
        blobStore.put({
          workspaceId: input.workspaceId,
          fileId: change.entry.fileId,
          sha256: change.entry.sha256,
          blob: input.blob,
        } satisfies StoredBlob);
        hooks.afterBlobPut?.();
        entryStore.put({
          ...change.entry,
          workspaceId: input.workspaceId,
        } satisfies StoredEntry);
        metaStore.put({
          workspaceId: input.workspaceId,
          lamport: change.lamport,
        } satisfies StoredMeta);
        result = change.entry;
      } catch (error) {
        abort(error);
      }
    };

    entriesRequest.onsuccess = () => {
      records = entriesRequest.result;
      commit();
    };
    metaRequest.onsuccess = () => {
      meta = metaRequest.result;
      metaReady = true;
      commit();
    };
    transaction.oncomplete = () => {
      committed = true;
      if (result) resolve(result);
      else reject(new Error("The local file write did not commit"));
    };
    transaction.onabort = () =>
      reject(failure ?? readableStoreError(transaction.error));
    transaction.onerror = () => {
      if (!committed && !failure)
        failure = readableStoreError(transaction.error);
    };
  });
}

export async function deleteLocalFile(
  workspaceId: string,
  fileId: string,
  role: WorkspaceRole,
  authoring: { author: string; authorName: string; modifiedAt: number },
): Promise<FileEntry> {
  if (role === "viewer")
    throw new Error("Viewers cannot change workspace files");
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      [ENTRY_STORE, BLOB_STORE, META_STORE],
      "readwrite",
    );
    const entryStore = transaction.objectStore(ENTRY_STORE);
    const blobStore = transaction.objectStore(BLOB_STORE);
    const metaStore = transaction.objectStore(META_STORE);
    const entriesRequest = entryStore.getAll() as IDBRequest<StoredEntry[]>;
    const metaRequest = metaStore.get(workspaceId) as IDBRequest<
      StoredMeta | undefined
    >;
    let records: StoredEntry[] | null = null;
    let meta: StoredMeta | undefined;
    let metaReady = false;
    let result: FileEntry | null = null;
    let failure: Error | null = null;

    const commit = (): void => {
      if (!records || !metaReady || result || failure) return;
      try {
        const workspaceEntries = records
          .filter((record) => record.workspaceId === workspaceId)
          .map(asEntry);
        const change = deleteLocalEntry(
          fileId,
          authoring,
          workspaceEntries,
          meta?.lamport ?? 0,
        );
        entryStore.put({ ...change.entry, workspaceId } satisfies StoredEntry);
        blobStore.delete([workspaceId, fileId]);
        metaStore.put({
          workspaceId,
          lamport: change.lamport,
        } satisfies StoredMeta);
        result = change.entry;
      } catch (error) {
        failure = readableStoreError(error);
        try {
          transaction.abort();
        } catch {
          reject(failure);
        }
      }
    };

    entriesRequest.onsuccess = () => {
      records = entriesRequest.result;
      commit();
    };
    metaRequest.onsuccess = () => {
      meta = metaRequest.result;
      metaReady = true;
      commit();
    };
    transaction.oncomplete = () => {
      if (result) resolve(result);
      else reject(new Error("The local delete did not commit"));
    };
    transaction.onabort = () =>
      reject(failure ?? readableStoreError(transaction.error));
    transaction.onerror = () => {
      if (!failure) failure = readableStoreError(transaction.error);
    };
  });
}

export async function adoptRemoteEntry(
  workspaceId: string,
  untrustedEntry: unknown,
): Promise<FileEntry> {
  const parsed = fileEntrySchema.safeParse(untrustedEntry);
  if (!parsed.success)
    throw new Error("Received invalid workspace file metadata");
  const entry = parsed.data;
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      [ENTRY_STORE, BLOB_STORE, META_STORE],
      "readwrite",
    );
    const entryStore = transaction.objectStore(ENTRY_STORE);
    const blobStore = transaction.objectStore(BLOB_STORE);
    const metaStore = transaction.objectStore(META_STORE);
    const metaRequest = metaStore.get(workspaceId) as IDBRequest<
      StoredMeta | undefined
    >;
    const blobRequest = blobStore.get([
      workspaceId,
      entry.fileId,
    ]) as IDBRequest<StoredBlob | undefined>;
    const entriesRequest = entryStore.getAll() as IDBRequest<StoredEntry[]>;
    let meta: StoredMeta | undefined;
    let metaReady = false;
    let blob: StoredBlob | undefined;
    let blobReady = false;
    let entries: StoredEntry[] = [];
    let entriesReady = false;
    let queued = false;
    let failure: Error | null = null;

    const commit = (): void => {
      if (!metaReady || !blobReady || !entriesReady || queued) return;
      queued = true;
      const currentRecords = entries.filter(
        (stored) => stored.workspaceId === workspaceId,
      );
      const existing = currentRecords.find(
        (stored) => stored.fileId === entry.fileId,
      );
      if (!existing && currentRecords.length >= MAX_FILES_PER_WORKSPACE) {
        failure = new Error("This workspace has reached its 500 file limit");
        transaction.abort();
        return;
      }
      if (existing) {
        const order = compareVersions(entry, asEntry(existing));
        if (order < 0 || (order === 0 && entry.sha256 !== existing.sha256)) {
          failure = new Error(
            "A newer workspace file version is already stored",
          );
          transaction.abort();
          return;
        }
      }
      entryStore.put({ ...entry, workspaceId } satisfies StoredEntry);
      if (entry.deleted || blob?.sha256 !== entry.sha256) {
        blobStore.delete([workspaceId, entry.fileId]);
      }
      metaStore.put({
        workspaceId,
        lamport: Math.max(meta?.lamport ?? 0, entry.lamport),
      } satisfies StoredMeta);
    };

    metaRequest.onsuccess = () => {
      meta = metaRequest.result;
      metaReady = true;
      commit();
    };
    blobRequest.onsuccess = () => {
      blob = blobRequest.result;
      blobReady = true;
      commit();
    };
    entriesRequest.onsuccess = () => {
      entries = entriesRequest.result;
      entriesReady = true;
      commit();
    };
    transaction.oncomplete = () => resolve(entry);
    transaction.onabort = () =>
      reject(failure ?? readableStoreError(transaction.error));
    transaction.onerror = () => {
      if (!failure) failure = readableStoreError(transaction.error);
    };
  });
}

export async function commitPulledFile(
  workspaceId: string,
  untrustedEntry: unknown,
  blob: Blob,
): Promise<FileEntry> {
  const parsed = fileEntrySchema.safeParse(untrustedEntry);
  if (!parsed.success || parsed.data.deleted) {
    throw new Error("Received invalid live workspace file metadata");
  }
  const entry = parsed.data;
  if (blob.size !== entry.size)
    throw new Error("Received file size does not match its entry");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await blob.arrayBuffer(),
  );
  if (hashToHex(digest) !== entry.sha256) {
    throw new Error("Received file hash does not match its entry");
  }

  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      [ENTRY_STORE, BLOB_STORE, META_STORE],
      "readwrite",
    );
    const entryStore = transaction.objectStore(ENTRY_STORE);
    const blobStore = transaction.objectStore(BLOB_STORE);
    const metaStore = transaction.objectStore(META_STORE);
    const metaRequest = metaStore.get(workspaceId) as IDBRequest<
      StoredMeta | undefined
    >;
    const existingRequest = entryStore.get([
      workspaceId,
      entry.fileId,
    ]) as IDBRequest<StoredEntry | undefined>;
    let failure: Error | null = null;
    let metaReady = false;
    let existingReady = false;
    let meta: StoredMeta | undefined;
    let existing: StoredEntry | undefined;
    const writeMeta = (): void => {
      if (!metaReady || !existingReady) return;
      if (existing) {
        const current = asEntry(existing);
        const order = compareVersions(entry, current);
        if (order < 0 || (order === 0 && entry.sha256 !== current.sha256)) {
          failure = new Error(
            "A newer workspace file version arrived during this pull",
          );
          transaction.abort();
          return;
        }
      }
      blobStore.put({
        workspaceId,
        fileId: entry.fileId,
        sha256: entry.sha256,
        blob,
      } satisfies StoredBlob);
      entryStore.put({
        ...entry,
        workspaceId,
      } satisfies StoredEntry);
      metaStore.put({
        workspaceId,
        lamport: Math.max(meta?.lamport ?? 0, entry.lamport),
      } satisfies StoredMeta);
    };
    metaRequest.onsuccess = () => {
      meta = metaRequest.result;
      metaReady = true;
      writeMeta();
    };
    existingRequest.onsuccess = () => {
      existing = existingRequest.result;
      existingReady = true;
      writeMeta();
    };
    transaction.oncomplete = () => resolve(entry);
    transaction.onabort = () =>
      reject(failure ?? readableStoreError(transaction.error));
    transaction.onerror = () => {
      if (!failure) failure = readableStoreError(transaction.error);
    };
  });
}

function hashToHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function closeFileLibraryForTests(): void {
  void databasePromise?.then((database) => database.close());
  databasePromise = null;
}
