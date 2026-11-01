import type { FileEntry } from "./types.js";

export function compareVersions(a: FileEntry, b: FileEntry): -1 | 0 | 1 {
  if (a.lamport !== b.lamport) return a.lamport < b.lamport ? -1 : 1;
  if (a.author === b.author) return 0;
  return a.author < b.author ? -1 : 1;
}
