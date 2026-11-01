import type { FileEntry, WorkspaceRole } from "@zerocloud/shared";

export type PullAuthorization =
  "allowed" | "not-found" | "hash-mismatch" | "forbidden";

export function authorizePullRequest(
  peerRole: WorkspaceRole | null,
  entry: FileEntry | undefined,
  storedBlobHash: string | null,
  requestedHash: string,
): PullAuthorization {
  if (peerRole === null) return "forbidden";
  if (!entry || entry.deleted) return "not-found";
  if (
    entry.sha256 !== requestedHash ||
    (storedBlobHash !== null && storedBlobHash !== requestedHash)
  ) {
    return "hash-mismatch";
  }
  return storedBlobHash === requestedHash ? "allowed" : "not-found";
}
