import { fileEntrySchema, liveFileEntryInputSchema } from "./schemas.js";
import type {
  FileEntry,
  LocalChangeResult,
  LocalFileMetadata,
} from "./types.js";

export function getNextLamport(
  entries: readonly Pick<FileEntry, "lamport">[],
  highWaterMark = 0,
): number {
  const highest = entries.reduce(
    (maximum, entry) => Math.max(maximum, entry.lamport),
    highWaterMark,
  );
  if (
    !Number.isSafeInteger(highest) ||
    highest < 0 ||
    highest >= Number.MAX_SAFE_INTEGER
  ) {
    throw new RangeError("Workspace Lamport clock is out of range");
  }
  return highest + 1;
}

export function createLocalEntry(
  input: LocalFileMetadata,
  entries: readonly FileEntry[],
  highWaterMark = 0,
): LocalChangeResult {
  if (entries.some((entry) => entry.fileId === input.fileId)) {
    throw new Error("A file with this identity already exists");
  }
  const lamport = getNextLamport(entries, highWaterMark);
  return {
    entry: fileEntrySchema.parse({
      ...liveFileEntryInputSchema.parse(input),
      lamport,
      deleted: false,
    }),
    lamport,
  };
}

export function replaceLocalEntry(
  fileId: string,
  input: Omit<LocalFileMetadata, "fileId">,
  entries: readonly FileEntry[],
  highWaterMark = 0,
): LocalChangeResult {
  const current = entries.find((entry) => entry.fileId === fileId);
  if (!current || current.deleted)
    throw new Error("The file to replace is not live");
  const lamport = getNextLamport(entries, highWaterMark);
  return {
    entry: fileEntrySchema.parse({
      ...liveFileEntryInputSchema.parse({ ...input, fileId }),
      lamport,
      deleted: false,
    }),
    lamport,
  };
}

export function deleteLocalEntry(
  fileId: string,
  authoring: Pick<LocalFileMetadata, "author" | "authorName" | "modifiedAt">,
  entries: readonly FileEntry[],
  highWaterMark = 0,
): LocalChangeResult {
  const current = entries.find((entry) => entry.fileId === fileId);
  if (!current || current.deleted)
    throw new Error("The file to delete is not live");
  const lamport = getNextLamport(entries, highWaterMark);
  return {
    entry: fileEntrySchema.parse({
      ...current,
      size: 0,
      sha256: "",
      author: authoring.author,
      authorName: authoring.authorName,
      lamport,
      modifiedAt: authoring.modifiedAt,
      deleted: true,
    }),
    lamport,
  };
}
