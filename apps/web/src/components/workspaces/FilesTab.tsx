"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { MAX_FILE_SIZE, MAX_FILES_PER_WORKSPACE } from "@zerocloud/shared";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import {
  deleteLocalFile,
  readBlob,
  readLibrary,
  saveLocalFile,
  type LibraryItem,
} from "../../lib/store/fileLibraryDb";
import {
  publishLocalFileChange,
  requestFileRetry,
  requestViewerForgery,
} from "../../lib/sync/syncEvents";
import { useSyncStore } from "../../lib/sync/sync-store";

type PendingConflict = { file: File; existing: LibraryItem["entry"] };

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function hashToHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function FilesTab({
  workspaceId,
  role,
  fingerprint,
  displayName,
}: {
  workspaceId: string;
  role: "owner" | "editor" | "viewer";
  fingerprint: string;
  displayName: string;
}) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(
    null,
  );
  const [showDeleted, setShowDeleted] = useState(false);
  const [simulateQuotaFailure, setSimulateQuotaFailure] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [conflict, setConflict] = useState<PendingConflict | null>(null);
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [replaceFileId, setReplaceFileId] = useState<string | null>(null);
  const [simulationRunning, setSimulationRunning] = useState(false);
  const simulationCancelled = useRef(false);
  const syncPeers = useSyncStore((state) => state.peers);
  const syncFiles = useSyncStore((state) => state.files);
  const connectedSyncPeers = Object.values(syncPeers).filter(
    (status) => status !== "offline",
  );
  const syncingFileCount = Object.values(syncFiles).filter(
    (file) => file.status === "queued" || file.status === "pulling",
  ).length;
  const stableFileStatuses = Object.entries(syncFiles)
    .filter(([, file]) => file.status !== "pulling")
    .map(([fileId, file]) => `${fileId}:${file.status}`)
    .sort()
    .join("|");
  const pickerRef = useRef<HTMLInputElement>(null);
  const replacementRef = useRef<HTMLInputElement>(null);
  const canWrite = role === "owner" || role === "editor";

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const library = await readLibrary(workspaceId);
      setItems(library.items);
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        if (estimate.usage !== undefined && estimate.quota !== undefined) {
          setUsage({ used: estimate.usage, quota: estimate.quota });
        }
      }
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not read local files",
      );
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    return () => {
      simulationCancelled.current = true;
    };
  }, []);

  useEffect(() => {
    if (stableFileStatuses) void refresh();
  }, [refresh, stableFileStatuses]);

  const visibleItems = useMemo(() => {
    const shown = items.filter((item) => showDeleted || !item.entry.deleted);
    const liveNameCounts = new Map<string, number>();
    for (const item of items) {
      if (!item.entry.deleted) {
        liveNameCounts.set(
          item.entry.name,
          (liveNameCounts.get(item.entry.name) ?? 0) + 1,
        );
      }
    }
    return shown.map((item) => ({
      ...item,
      displayName:
        !item.entry.deleted && (liveNameCounts.get(item.entry.name) ?? 0) > 1
          ? `${item.entry.name} (from ${item.entry.authorName})`
          : item.entry.name,
    }));
  }, [items, showDeleted]);

  async function storeFile(
    file: File,
    mode: "create" | "replace",
    fileId?: string,
  ): Promise<void> {
    if (!canWrite) {
      setError("Viewers cannot change workspace files");
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setError(`${file.name} exceeds the 500 MB limit`);
      return;
    }
    setPreparing(file.name);
    setError(null);
    try {
      const sha256 = hashToHex(
        await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
      );
      const entry = await saveLocalFile(
        {
          workspaceId,
          role,
          mode,
          metadata: {
            fileId: fileId ?? crypto.randomUUID(),
            name: file.name,
            size: file.size,
            sha256,
            author: fingerprint,
            authorName: displayName,
            modifiedAt: Date.now(),
          },
          blob: file,
        },
        simulateQuotaFailure
          ? {
              afterBlobPut: () => {
                throw new DOMException(
                  "Simulated browser storage quota",
                  "QuotaExceededError",
                );
              },
            }
          : {},
      );
      publishLocalFileChange(workspaceId, entry);
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : `Could not save ${file.name}`,
      );
    } finally {
      setPreparing(null);
    }
  }

  async function uploadFiles(
    files: File[],
    explicitFileId?: string,
  ): Promise<void> {
    if (!canWrite) {
      setError("Viewers cannot change workspace files");
      return;
    }
    try {
      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        if (!file) continue;
        const latestItems = (await readLibrary(workspaceId)).items;
        setItems(latestItems);
        const existing = explicitFileId
          ? latestItems.find((item) => item.entry.fileId === explicitFileId)
              ?.entry
          : latestItems.find(
              (item) => !item.entry.deleted && item.entry.name === file.name,
            )?.entry;
        if (explicitFileId && existing) {
          await storeFile(file, "replace", existing.fileId);
          continue;
        }
        if (existing) {
          setConflict({ file, existing });
          setQueuedFiles(files.slice(index + 1));
          return;
        }
        await storeFile(file, "create");
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not prepare selected files",
      );
    }
  }

  async function resolveConflict(choice: "replace" | "keep"): Promise<void> {
    if (!conflict) return;
    const pending = conflict;
    const rest = queuedFiles;
    setConflict(null);
    setQueuedFiles([]);
    await storeFile(
      pending.file,
      choice === "replace" ? "replace" : "create",
      choice === "replace" ? pending.existing.fileId : undefined,
    );
    if (rest.length) await uploadFiles(rest);
  }

  async function download(item: LibraryItem): Promise<void> {
    try {
      const blob = await readBlob(
        workspaceId,
        item.entry.fileId,
        item.entry.sha256,
      );
      if (!blob) {
        await refresh();
        setError(
          "This file is missing locally. It will be available after sync is added.",
        );
        return;
      }
      downloadBlob(blob, item.entry.name);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not download this file",
      );
    }
  }

  async function remove(item: LibraryItem): Promise<void> {
    if (
      !canWrite ||
      !window.confirm(
        `Delete “${item.entry.name}” from this workspace library?`,
      )
    )
      return;
    try {
      const entry = await deleteLocalFile(
        workspaceId,
        item.entry.fileId,
        role,
        {
          author: fingerprint,
          authorName: displayName,
          modifiedAt: Date.now(),
        },
      );
      publishLocalFileChange(workspaceId, entry);
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not delete this file",
      );
    }
  }

  async function simulateRandomOps(): Promise<void> {
    if (!canWrite || simulationRunning) return;
    simulationCancelled.current = false;
    setSimulationRunning(true);
    setError(null);
    const deadline = Date.now() + 60_000;
    try {
      while (!simulationCancelled.current && Date.now() < deadline) {
        const library = await readLibrary(workspaceId);
        const live = library.items.filter(
          (item) => !item.entry.deleted && item.status === "present",
        );
        const op = Math.random();
        let changed: LibraryItem["entry"] | null = null;
        if (op < 0.35 && library.items.length < MAX_FILES_PER_WORKSPACE) {
          const file = new File(
            [`random sync sample ${crypto.randomUUID()}\n`],
            `sample-${crypto.randomUUID().slice(0, 8)}.txt`,
            { type: "text/plain", lastModified: Date.now() },
          );
          const sha256 = hashToHex(
            await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
          );
          changed = await saveLocalFile({
            workspaceId,
            role,
            mode: "create",
            metadata: {
              fileId: crypto.randomUUID(),
              name: file.name,
              size: file.size,
              sha256,
              author: fingerprint,
              authorName: displayName,
              modifiedAt: Date.now(),
            },
            blob: file,
          });
        } else if (live.length > 0 && op < 0.68) {
          const target = live[Math.floor(Math.random() * live.length)];
          if (target) {
            changed = await deleteLocalFile(
              workspaceId,
              target.entry.fileId,
              role,
              {
                author: fingerprint,
                authorName: displayName,
                modifiedAt: Date.now(),
              },
            );
          }
        } else if (live.length > 0) {
          const target = live[Math.floor(Math.random() * live.length)];
          if (target) {
            const file = new File(
              [`replacement ${crypto.randomUUID()}\n`],
              target.entry.name,
              { type: "text/plain", lastModified: Date.now() },
            );
            const sha256 = hashToHex(
              await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
            );
            changed = await saveLocalFile({
              workspaceId,
              role,
              mode: "replace",
              metadata: {
                fileId: target.entry.fileId,
                name: file.name,
                size: file.size,
                sha256,
                author: fingerprint,
                authorName: displayName,
                modifiedAt: Date.now(),
              },
              blob: file,
            });
          }
        }
        if (changed) publishLocalFileChange(workspaceId, changed);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
      }
      if (!simulationCancelled.current) await refresh();
    } catch (caught) {
      if (!simulationCancelled.current) {
        setError(
          caught instanceof Error
            ? caught.message
            : "Random sync simulation failed",
        );
      }
    } finally {
      if (!simulationCancelled.current) setSimulationRunning(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setDragActive(false);
    if (canWrite) void uploadFiles(Array.from(event.dataTransfer.files));
  }

  const percentUsed = usage?.quota
    ? Math.min(100, (usage.used / usage.quota) * 100)
    : 0;

  return (
    <Card className="border-zinc-800 bg-zinc-950">
      <CardHeader>
        <CardTitle>Workspace files</CardTitle>
        <CardDescription>
          Workspace files sync directly between secure peers. Local copies are
          plaintext at rest in this browser.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-rose-900 bg-rose-950/50 p-3 text-sm text-rose-200"
          >
            {error}
          </p>
        )}
        {usage && (
          <div>
            <div className="flex justify-between text-xs text-zinc-400">
              <span>Browser storage</span>
              <span>
                {formatSize(usage.used)} / {formatSize(usage.quota)}
              </span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-zinc-800">
              <div
                className={`h-full ${percentUsed >= 80 ? "bg-amber-400" : "bg-violet-400"}`}
                style={{ width: `${percentUsed}%` }}
              />
            </div>
            {percentUsed >= 80 && (
              <p className="mt-1 text-xs text-amber-300">
                Browser storage is at least 80% full.
              </p>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs">
          <span className="text-zinc-300">
            {connectedSyncPeers.length === 0
              ? "Offline: no peers connected"
              : syncingFileCount > 0
                ? `Syncing: ${syncingFileCount} files`
                : connectedSyncPeers.some(
                      (status) => status === "syncing" || status === "error",
                    )
                  ? `Syncing with ${connectedSyncPeers.length} peers`
                  : `In sync with ${connectedSyncPeers.filter((status) => status === "in-sync").length} peers`}
          </span>
          {process.env.NODE_ENV === "development" && canWrite && (
            <Button
              variant="outline"
              disabled={simulationRunning}
              onClick={() => void simulateRandomOps()}
            >
              {simulationRunning
                ? "Simulating (up to 60s)…"
                : "Simulate random ops"}
            </Button>
          )}
          {process.env.NODE_ENV === "development" &&
            role === "viewer" &&
            process.env.NEXT_PUBLIC_DEBUG_FORGE_VIEWER === "true" && (
              <Button
                variant="outline"
                onClick={() => requestViewerForgery(workspaceId)}
              >
                Forge viewer delta (debug)
              </Button>
            )}
        </div>
        {canWrite && (
          <div
            onDragOver={(event) => {
              event.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={handleDrop}
            className={`rounded-xl border border-dashed p-6 text-center ${dragActive ? "border-violet-400 bg-violet-950/30" : "border-zinc-700 bg-zinc-900/40"}`}
          >
            <p className="text-sm text-zinc-300">
              Drop files here to add them to this browser’s library
            </p>
            <Button
              className="mt-3"
              disabled={preparing !== null}
              onClick={() => pickerRef.current?.click()}
            >
              Choose files
            </Button>
            <input
              ref={pickerRef}
              className="hidden"
              type="file"
              multiple
              onChange={(event) => {
                const selected = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                void uploadFiles(selected);
              }}
            />
            <input
              ref={replacementRef}
              className="hidden"
              type="file"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                const id = replaceFileId;
                event.currentTarget.value = "";
                setReplaceFileId(null);
                if (file && id) void uploadFiles([file], id);
              }}
            />
            {preparing && (
              <p className="mt-3 text-xs text-violet-200">
                Hashing and saving {preparing}…
              </p>
            )}
            {process.env.NODE_ENV === "development" && (
              <label className="mt-3 flex items-center justify-center gap-2 text-xs text-zinc-500">
                <input
                  type="checkbox"
                  checked={simulateQuotaFailure}
                  onChange={(event) =>
                    setSimulateQuotaFailure(event.currentTarget.checked)
                  }
                />
                Simulate quota failure (development)
              </label>
            )}
          </div>
        )}
        {conflict && (
          <div
            role="dialog"
            aria-label="File name conflict"
            className="rounded-lg border border-amber-800 bg-amber-950/30 p-4"
          >
            <p className="text-sm text-amber-100">
              “{conflict.file.name}” already exists. Replace the existing file
              or keep both?
            </p>
            <div className="mt-3 flex gap-2">
              <Button onClick={() => void resolveConflict("replace")}>
                Replace existing
              </Button>
              <Button
                variant="outline"
                onClick={() => void resolveConflict("keep")}
              >
                Keep both
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setConflict(null);
                  setQueuedFiles([]);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
        <div className="flex items-center justify-between">
          <p className="text-xs text-zinc-500">
            {items.filter((item) => !item.entry.deleted).length} live ·{" "}
            {items.filter((item) => item.entry.deleted).length} deleted
          </p>
          <label className="flex items-center gap-2 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={showDeleted}
              onChange={(event) => setShowDeleted(event.currentTarget.checked)}
            />
            Show deleted
          </label>
        </div>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="bg-zinc-900 text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-3 py-3">Name</th>
                <th className="px-3 py-3">Size</th>
                <th className="px-3 py-3">Status</th>
                <th className="px-3 py-3">Last modified</th>
                <th className="px-3 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {visibleItems.map((item) => {
                const fileSync = syncFiles[item.entry.fileId];
                return (
                  <tr key={item.entry.fileId}>
                    <td
                      className="max-w-64 truncate px-3 py-3"
                      title={item.displayName}
                    >
                      {item.displayName}
                    </td>
                    <td className="px-3 py-3 text-zinc-400">
                      {formatSize(item.entry.size)}
                    </td>
                    <td className="px-3 py-3">
                      <span
                        className={`rounded-full px-2 py-1 text-xs ${item.entry.deleted ? "bg-zinc-800 text-zinc-400" : fileSync?.status === "synced" ? "bg-emerald-950 text-emerald-300" : fileSync?.status === "pulling" ? "bg-sky-950 text-sky-200" : fileSync?.status === "failed" ? "bg-rose-950 text-rose-200" : "bg-amber-950 text-amber-300"}`}
                      >
                        {item.entry.deleted
                          ? "Deleted-hidden"
                          : fileSync?.status === "pulling"
                            ? `Pulling ${Math.round(fileSync.progress * 100)}%`
                            : fileSync?.status === "queued"
                              ? "Queued"
                              : fileSync?.status === "failed"
                                ? "Failed"
                                : fileSync?.status === "synced"
                                  ? "Synced"
                                  : item.status === "present"
                                    ? "Present locally"
                                    : "Missing"}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-xs text-zinc-400">
                      {item.entry.authorName} ·{" "}
                      {relativeTime(item.entry.modifiedAt)}
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex gap-2">
                        {!item.entry.deleted && (
                          <Button
                            variant="outline"
                            className="px-2 py-1 text-xs"
                            onClick={() => void download(item)}
                          >
                            Download
                          </Button>
                        )}
                        {fileSync?.status === "failed" && (
                          <Button
                            variant="outline"
                            className="px-2 py-1 text-xs"
                            onClick={() =>
                              requestFileRetry(workspaceId, item.entry.fileId)
                            }
                          >
                            Retry
                          </Button>
                        )}
                        {canWrite && !item.entry.deleted && (
                          <>
                            <Button
                              variant="outline"
                              className="px-2 py-1 text-xs"
                              disabled={preparing !== null}
                              onClick={() => {
                                setReplaceFileId(item.entry.fileId);
                                replacementRef.current?.click();
                              }}
                            >
                              Replace
                            </Button>
                            <Button
                              variant="outline"
                              className="px-2 py-1 text-xs text-rose-300"
                              onClick={() => void remove(item)}
                            >
                              Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && visibleItems.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-8 text-center text-sm text-zinc-500"
                  >
                    No files in this browser’s library yet.
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-3 py-8 text-center text-sm text-zinc-500"
                  >
                    Loading local library…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
