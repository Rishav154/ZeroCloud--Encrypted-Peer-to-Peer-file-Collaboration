import {
  MAX_FILES_PER_WORKSPACE,
  MAX_MANIFEST_SIZE,
  fileEntrySchema,
} from "./schemas.js";
import type { FileEntry, ManifestDiff, WriterContext } from "./types.js";
import { compareVersions } from "./versions.js";

export function diffManifests(
  local: FileEntry[],
  remote: FileEntry[],
  ctx: WriterContext,
): ManifestDiff {
  const result: ManifestDiff = { pull: [], adopt: [], ignore: [], reject: [] };
  const localById = new Map(local.map((entry) => [entry.fileId, entry]));
  const seen = new Set<string>();
  const serializedSize = new TextEncoder().encode(
    JSON.stringify(remote),
  ).byteLength;
  if (
    remote.length > MAX_FILES_PER_WORKSPACE ||
    serializedSize > MAX_MANIFEST_SIZE
  ) {
    for (const entry of remote) {
      result.reject.push({
        entry,
        reason: "Manifest exceeds workspace limits",
      });
    }
    return result;
  }

  for (const value of remote as unknown[]) {
    const parsed = fileEntrySchema.safeParse(value);
    if (!parsed.success) {
      result.reject.push({
        entry: value,
        reason: "Entry does not match the file schema",
      });
      continue;
    }
    const entry = parsed.data;
    if (seen.has(entry.fileId)) {
      result.reject.push({
        entry,
        reason: "Manifest contains a duplicate file ID",
      });
      continue;
    }
    seen.add(entry.fileId);
    if (!ctx.isWriter(entry.author)) {
      result.reject.push({
        entry,
        reason: "Entry author is not a current workspace writer",
      });
      continue;
    }

    const current = localById.get(entry.fileId);
    if (!current) {
      (entry.deleted ? result.adopt : result.pull).push(entry);
      continue;
    }

    const order = compareVersions(entry, current);
    if (order <= 0) {
      result.ignore.push(entry);
      continue;
    }
    if (entry.deleted || entry.sha256 === current.sha256) {
      result.adopt.push(entry);
    } else {
      result.pull.push(entry);
    }
  }
  return result;
}
