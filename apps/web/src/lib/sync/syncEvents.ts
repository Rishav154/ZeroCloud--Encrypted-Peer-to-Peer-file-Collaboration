import { TypedEventEmitter } from "../webrtc/TypedEventEmitter";
import type { FileEntry } from "@zerocloud/shared";

type SyncEvents = {
  localChange: { workspaceId: string; entry: FileEntry };
  retryFile: { workspaceId: string; fileId: string };
  forgeViewer: { workspaceId: string };
};

const syncEvents = new TypedEventEmitter<SyncEvents>();

export function publishLocalFileChange(
  workspaceId: string,
  entry: FileEntry,
): void {
  syncEvents.emit("localChange", { workspaceId, entry });
}

export function onLocalFileChange(
  listener: (event: SyncEvents["localChange"]) => void,
): () => void {
  return syncEvents.on("localChange", listener);
}

export function requestFileRetry(workspaceId: string, fileId: string): void {
  syncEvents.emit("retryFile", { workspaceId, fileId });
}

export function onFileRetry(
  listener: (event: SyncEvents["retryFile"]) => void,
): () => void {
  return syncEvents.on("retryFile", listener);
}

export function requestViewerForgery(workspaceId: string): void {
  syncEvents.emit("forgeViewer", { workspaceId });
}

export function onViewerForgery(
  listener: (event: SyncEvents["forgeViewer"]) => void,
): () => void {
  return syncEvents.on("forgeViewer", listener);
}
