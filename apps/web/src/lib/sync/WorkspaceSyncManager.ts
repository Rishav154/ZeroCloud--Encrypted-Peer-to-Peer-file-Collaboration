import {
  createDeltaMessages,
  createSyncId,
  compareVersions,
  diffManifests,
  fragmentManifest,
  type FileEntry,
  type PullDeniedMessage,
  type PullRequestMessage,
  type SyncPayload,
  type WorkspaceRole,
} from "@zerocloud/shared";
import {
  adoptRemoteEntry,
  commitPulledFile,
  readStoredBlob,
  readLibrary,
} from "../store/fileLibraryDb";
import type { SyncPullExpectation } from "../transfer/FileReceiver";
import type { SyncTransferOptions, TransferSnapshot } from "../transfer/types";
import { ManifestAssembler } from "./ManifestAssembler";
import { authorizePullRequest } from "./pullAuthorization";
import { onFileRetry, onLocalFileChange, onViewerForgery } from "./syncEvents";
import {
  useSyncStore,
  type FileSyncSnapshot,
  type PeerSyncStatus,
} from "./sync-store";

type SyncMember = { fingerprint: string; role: WorkspaceRole };
type SyncPeerAdapter = {
  isSecure(peerId: string): boolean;
  getRole(peerId: string): WorkspaceRole | null;
  send(peerId: string, messages: SyncPayload[]): Promise<boolean>;
  expectPull(peerId: string, expectation: SyncPullExpectation): boolean;
  cancelPull(peerId: string, requestId: string): void;
  sendFile(
    peerId: string,
    file: File,
    options: SyncTransferOptions,
  ): number | null;
};
type SyncLogger = (event: string, peerId?: string, error?: boolean) => void;

type PullJob = {
  key: string;
  entry: FileEntry;
  sources: string[];
  attempts: number;
  activePeerId: string | null;
  requestId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  fileTimer: ReturnType<typeof setTimeout> | null;
  progress: number;
  sourceIndex: number;
  done: boolean;
  finalizing: boolean;
};

type PendingPull = { job: PullJob; peerId: string };

const MAX_ACTIVE_PULLS = 4;
const MAX_PULLS_PER_PEER = 2;
const MAX_PULL_ATTEMPTS = 3;
const MAX_FILE_WAIT_MS = 70_000;

function pullKey(entry: Pick<FileEntry, "fileId" | "sha256">): string {
  return `${entry.fileId}:${entry.sha256}`;
}

export class WorkspaceSyncManager {
  private readonly assembler = new ManifestAssembler();
  private readonly securePeers = new Set<string>();
  private readonly processedManifestPeers = new Set<string>();
  private readonly jobs = new Map<string, PullJob>();
  private readonly queue: PullJob[] = [];
  private readonly pendingByRequest = new Map<string, PendingPull>();
  private readonly peerActivePulls = new Map<string, number>();
  private readonly unsubscribers: Array<() => void>;
  private activePulls = 0;
  private pumping = false;
  private destroyed = false;

  constructor(
    private readonly workspaceId: string,
    private readonly localFingerprint: string,
    private readonly getLocalRole: () => WorkspaceRole,
    private readonly getMembers: () => SyncMember[],
    private readonly adapter: SyncPeerAdapter,
    private readonly log: SyncLogger,
  ) {
    useSyncStore.getState().setWorkspace(workspaceId);
    this.unsubscribers = [
      onLocalFileChange((event) => {
        if (event.workspaceId !== this.workspaceId || this.destroyed) return;
        void this.broadcastLocalChange(event.entry).catch((error: unknown) => {
          this.log(
            `sync-local-change-failed:${readableError(error)}`,
            undefined,
            true,
          );
        });
      }),
      onFileRetry((event) => {
        if (event.workspaceId !== this.workspaceId || this.destroyed) return;
        void this.retryFile(event.fileId).catch((error: unknown) => {
          this.log(
            `sync-retry-failed:${readableError(error)}`,
            undefined,
            true,
          );
        });
      }),
      onViewerForgery((event) => {
        if (event.workspaceId !== this.workspaceId || this.destroyed) return;
        void this.forgeViewerDelta().catch((error: unknown) => {
          this.log(
            `sync-forgery-test-failed:${readableError(error)}`,
            undefined,
            true,
          );
        });
      }),
    ];
  }

  peerState(
    peerId: string,
    handshakeState: string,
    role: WorkspaceRole | null,
    workspaceVerified = false,
  ): void {
    if (this.destroyed) return;
    if (
      handshakeState === "secure" &&
      role !== null &&
      workspaceVerified &&
      this.adapter.isSecure(peerId)
    ) {
      if (!this.securePeers.has(peerId)) {
        this.securePeers.add(peerId);
        useSyncStore.getState().setPeer(peerId, "syncing");
        void this.sendManifest(peerId).catch((error: unknown) => {
          this.log(
            `sync-manifest-send-failed:${readableError(error)}`,
            peerId,
            true,
          );
        });
      }
      this.pumpPulls();
      return;
    }
    if (this.securePeers.delete(peerId)) {
      this.processedManifestPeers.delete(peerId);
      useSyncStore.getState().setPeer(peerId, "offline");
      this.pausePeerPulls(peerId);
    }
  }

  peerRemoved(peerId: string): void {
    this.securePeers.delete(peerId);
    this.processedManifestPeers.delete(peerId);
    this.assembler.discardPeer(peerId);
    useSyncStore.getState().removePeer(peerId);
    this.pausePeerPulls(peerId);
    this.refreshPeerStates();
  }

  async receive(peerId: string, message: SyncPayload): Promise<void> {
    if (this.destroyed || !this.isEligiblePeer(peerId)) return;
    if (message.type === "manifest") {
      try {
        const result = this.assembler.add(peerId, message);
        if (result.status === "complete") {
          this.log(
            `sync-manifest-received:entries=${result.entries.length}`,
            peerId,
          );
          await this.processRemoteEntries(peerId, result.entries);
          this.processedManifestPeers.add(peerId);
          this.refreshPeerStates();
        } else if (result.status === "duplicate" || result.status === "stale") {
          this.log(`sync-manifest-${result.status}`, peerId);
        }
      } catch (error) {
        this.assembler.discard(peerId, message.syncId);
        this.log(
          `sync-manifest-rejected:${readableError(error)}`,
          peerId,
          true,
        );
        useSyncStore.getState().setPeer(peerId, "error");
      }
      return;
    }
    if (message.type === "delta") {
      await this.processRemoteEntries(peerId, message.entries);
      this.log(`sync-delta-received:entries=${message.entries.length}`, peerId);
      await this.sendManifest(peerId);
      this.processedManifestPeers.add(peerId);
      this.refreshPeerStates();
      return;
    }
    if (message.type === "pull-request") {
      await this.handlePullRequest(peerId, message);
      return;
    }
    await this.handlePullDenied(peerId, message);
  }

  rejected(peerId: string, syncId: string | undefined, reason: string): void {
    if (syncId) this.assembler.discard(peerId, syncId);
    this.log(`sync-message-rejected:${reason}`, peerId, true);
    useSyncStore.getState().setPeer(peerId, "error");
  }

  transfer(snapshot: TransferSnapshot): void {
    if (
      this.destroyed ||
      snapshot.direction !== "incoming" ||
      snapshot.purpose !== "sync" ||
      !snapshot.requestId
    ) {
      return;
    }
    const pending = this.pendingByRequest.get(snapshot.requestId);
    if (!pending || pending.peerId !== snapshot.peerId) return;
    const { job } = pending;
    job.progress = snapshot.progress;
    if (snapshot.state === "done" && snapshot.blob) {
      if (job.finalizing) return;
      job.finalizing = true;
      void this.finishPulledFile(job, snapshot.blob).catch((error: unknown) => {
        if (this.destroyed) return;
        job.finalizing = false;
        this.log(
          `sync-file-commit-failed:${readableError(error)}`,
          snapshot.peerId,
          true,
        );
        this.failAttempt(job, "Downloaded file failed local verification");
      });
      return;
    }
    if (["failed", "rejected", "cancelled"].includes(snapshot.state)) {
      this.failAttempt(job, snapshot.error ?? `Transfer ${snapshot.state}`);
      return;
    }
    this.setFileStatus(job.entry.fileId, {
      status: "pulling",
      progress: snapshot.progress,
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.assembler.destroy();
    for (const job of this.jobs.values()) {
      if (job.timer) clearTimeout(job.timer);
      if (job.fileTimer) clearTimeout(job.fileTimer);
      if (job.activePeerId && job.requestId) {
        this.adapter.cancelPull(job.activePeerId, job.requestId);
      }
    }
    this.jobs.clear();
    this.queue.length = 0;
    this.pendingByRequest.clear();
    this.securePeers.clear();
    useSyncStore.getState().reset();
  }

  private isWriter(fingerprint: string): boolean {
    if (fingerprint === this.localFingerprint) {
      return (
        this.getLocalRole() === "owner" || this.getLocalRole() === "editor"
      );
    }
    return this.getMembers().some(
      (member) =>
        member.fingerprint === fingerprint &&
        (member.role === "owner" || member.role === "editor"),
    );
  }

  private isEligiblePeer(peerId: string): boolean {
    return (
      this.securePeers.has(peerId) &&
      this.adapter.isSecure(peerId) &&
      this.adapter.getRole(peerId) !== null
    );
  }

  private async sendManifest(peerId: string): Promise<void> {
    if (!this.isEligiblePeer(peerId)) return;
    const library = await readLibrary(this.workspaceId);
    const entries = library.items.map((item) => item.entry);
    const syncId = createSyncId();
    const fragments = fragmentManifest(entries, syncId);
    const sent = await this.adapter.send(peerId, fragments);
    if (!sent) throw new Error("Peer is not ready to receive a manifest");
    const byteCount = new TextEncoder().encode(
      JSON.stringify(entries),
    ).byteLength;
    this.log(
      `sync-manifest-sent:bytes=${byteCount}:parts=${fragments.length}`,
      peerId,
    );
  }

  private async broadcastLocalChange(entry: FileEntry): Promise<void> {
    if (this.getLocalRole() === "viewer") {
      this.log("sync-local-change-refused:viewer-role", undefined, true);
      return;
    }
    const messages = createDeltaMessages([entry]);
    this.setFileStatus(entry.fileId, { status: "queued", progress: 0 });
    const peers = [...this.securePeers].filter((peerId) =>
      this.isEligiblePeer(peerId),
    );
    for (const peerId of peers) {
      useSyncStore.getState().setPeer(peerId, "syncing");
      const sent = await this.adapter.send(peerId, messages);
      if (!sent) this.log("sync-delta-send-failed", peerId, true);
    }
    if (peers.length === 0) {
      this.setFileStatus(entry.fileId, { status: "queued", progress: 0 });
    }
    this.log(`sync-delta-sent:file=${entry.fileId}:peers=${peers.length}`);
    void this.updateStateHash().catch((error: unknown) => {
      this.log(
        `sync-state-hash-failed:${readableError(error)}`,
        undefined,
        true,
      );
    });
  }

  private async processRemoteEntries(
    peerId: string,
    remote: FileEntry[],
  ): Promise<void> {
    const library = await readLibrary(this.workspaceId);
    const localEntries = library.items.map((item) => item.entry);
    const localById = new Map(
      library.items.map((item) => [item.entry.fileId, item]),
    );
    const diff = diffManifests(localEntries, remote, {
      isWriter: (fingerprint) => this.isWriter(fingerprint),
    });
    this.log(
      `sync-diff:pull=${diff.pull.length}:adopt=${diff.adopt.length}:ignore=${diff.ignore.length}:reject=${diff.reject.length}`,
      peerId,
    );
    for (const rejected of diff.reject) {
      this.log(`sync-entry-rejected:${rejected.reason}`, peerId, true);
    }
    const accepted = [...diff.pull, ...diff.adopt, ...diff.ignore];
    for (const entry of accepted) {
      if (!entry.deleted) this.addSource(entry, peerId);
    }
    for (const entry of diff.adopt) {
      const previous = localById.get(entry.fileId);
      await adoptRemoteEntry(this.workspaceId, entry);
      if (entry.deleted) {
        this.setFileStatus(entry.fileId, { status: "synced", progress: 1 });
      } else if (
        previous?.status !== "present" ||
        previous.entry.sha256 !== entry.sha256
      ) {
        this.enqueuePull(entry, peerId);
      } else {
        this.setFileStatus(entry.fileId, { status: "synced", progress: 1 });
      }
    }
    for (const entry of diff.pull) {
      await adoptRemoteEntry(this.workspaceId, entry);
      this.enqueuePull(entry, peerId);
    }
    for (const entry of diff.ignore) {
      const local = localById.get(entry.fileId);
      if (local && compareVersions(local.entry, entry) > 0) {
        const sent = await this.adapter.send(
          peerId,
          createDeltaMessages([local.entry]),
        );
        if (!sent) {
          this.log(
            `sync-winning-delta-send-failed:${entry.fileId}`,
            peerId,
            true,
          );
        }
      } else if (
        local?.status === "present" &&
        local.entry.sha256 === entry.sha256
      ) {
        this.setFileStatus(entry.fileId, { status: "synced", progress: 1 });
      }
      if (
        !entry.deleted &&
        local?.status === "missing" &&
        local.entry.sha256 === entry.sha256
      ) {
        this.enqueuePull(local.entry, peerId);
      }
    }
    this.refreshPeerStates();
    this.pumpPulls();
    void this.updateStateHash().catch((error: unknown) => {
      this.log(
        `sync-state-hash-failed:${readableError(error)}`,
        undefined,
        true,
      );
    });
  }

  private enqueuePull(entry: FileEntry, sourcePeerId: string): void {
    if (entry.deleted) return;
    const key = pullKey(entry);
    let job = this.jobs.get(key);
    if (!job) {
      job = {
        key,
        entry,
        sources: [],
        attempts: 0,
        activePeerId: null,
        requestId: null,
        timer: null,
        fileTimer: null,
        progress: 0,
        sourceIndex: 0,
        done: false,
        finalizing: false,
      };
      this.jobs.set(key, job);
      this.queue.push(job);
    }
    if (!job.sources.includes(sourcePeerId)) job.sources.push(sourcePeerId);
    this.setFileStatus(entry.fileId, {
      status: "queued",
      progress: job.progress,
    });
  }

  private pumpPulls(): void {
    if (this.pumping || this.destroyed) return;
    this.pumping = true;
    try {
      while (this.activePulls < MAX_ACTIVE_PULLS) {
        const index = this.queue.findIndex((job) => {
          if (job.done || job.activePeerId || job.timer) return false;
          return job.sources.some(
            (peerId) =>
              this.isEligiblePeer(peerId) &&
              (this.peerActivePulls.get(peerId) ?? 0) < MAX_PULLS_PER_PEER,
          );
        });
        if (index < 0) break;
        const [job] = this.queue.splice(index, 1);
        if (job) void this.startAttempt(job);
      }
    } finally {
      this.pumping = false;
      this.refreshPeerStates();
    }
  }

  private async startAttempt(job: PullJob): Promise<void> {
    if (this.destroyed || job.done || job.activePeerId) return;
    const candidates = job.sources.filter(
      (peerId) =>
        this.isEligiblePeer(peerId) &&
        (this.peerActivePulls.get(peerId) ?? 0) < MAX_PULLS_PER_PEER,
    );
    const peerId = candidates[job.sourceIndex % candidates.length];
    if (!peerId) {
      if (!this.queue.includes(job)) this.queue.push(job);
      return;
    }
    job.sourceIndex += 1;
    if (job.attempts >= MAX_PULL_ATTEMPTS) {
      this.failJob(job, "Could not retrieve file after three attempts");
      return;
    }
    const requestId = crypto.randomUUID();
    const expectation: SyncPullExpectation = {
      requestId,
      fileId: job.entry.fileId,
      size: job.entry.size,
      sha256: job.entry.sha256,
    };
    if (!this.adapter.expectPull(peerId, expectation)) {
      this.retryJob(job, "Peer is no longer ready");
      return;
    }
    job.attempts += 1;
    job.activePeerId = peerId;
    job.requestId = requestId;
    this.activePulls += 1;
    this.peerActivePulls.set(
      peerId,
      (this.peerActivePulls.get(peerId) ?? 0) + 1,
    );
    this.pendingByRequest.set(requestId, { job, peerId });
    job.fileTimer = setTimeout(
      () => this.failAttempt(job, "File transfer timed out"),
      MAX_FILE_WAIT_MS,
    );
    this.setFileStatus(job.entry.fileId, { status: "pulling", progress: 0 });
    const request: PullRequestMessage = {
      type: "pull-request",
      syncId: createSyncId(),
      requestId,
      fileId: job.entry.fileId,
      sha256: job.entry.sha256,
    };
    const sent = await this.adapter.send(peerId, [request]);
    if (!sent && job.activePeerId === peerId) {
      this.failAttempt(job, "Could not send file pull request");
    } else {
      this.log(
        `sync-pull-requested:${job.entry.fileId}:attempt=${job.attempts}`,
        peerId,
      );
    }
  }

  private async handlePullRequest(
    peerId: string,
    request: PullRequestMessage,
  ): Promise<void> {
    const library = await readLibrary(this.workspaceId);
    const item = library.items.find(
      (candidate) => candidate.entry.fileId === request.fileId,
    );
    const stored = await readStoredBlob(this.workspaceId, request.fileId);
    const authorization = authorizePullRequest(
      this.isEligiblePeer(peerId) ? this.adapter.getRole(peerId) : null,
      item?.entry,
      stored?.sha256 ?? null,
      request.sha256,
    );
    if (authorization !== "allowed") {
      await this.sendPullDenied(peerId, request.requestId, authorization);
      return;
    }
    if (!item || !stored) {
      await this.sendPullDenied(peerId, request.requestId, "not-found");
      return;
    }
    const blob = stored.blob;
    const file = new File([blob], item.entry.name, {
      type: "application/octet-stream",
      lastModified: item.entry.modifiedAt,
    });
    const transferId = this.adapter.sendFile(peerId, file, {
      purpose: "sync",
      requestId: request.requestId,
    });
    if (transferId === null) {
      await this.sendPullDenied(peerId, request.requestId, "forbidden");
      return;
    }
    this.log(`sync-pull-fulfilled:${request.fileId}`, peerId);
  }

  private async sendPullDenied(
    peerId: string,
    requestId: string,
    reason: PullDeniedMessage["reason"],
  ): Promise<void> {
    const message: PullDeniedMessage = {
      type: "pull-denied",
      syncId: createSyncId(),
      requestId,
      reason,
    };
    await this.adapter.send(peerId, [message]);
  }

  private async handlePullDenied(
    peerId: string,
    message: PullDeniedMessage,
  ): Promise<void> {
    const pending = this.pendingByRequest.get(message.requestId);
    if (!pending || pending.peerId !== peerId) return;
    this.failAttempt(pending.job, `Peer denied file pull: ${message.reason}`);
  }

  private async finishPulledFile(job: PullJob, blob: Blob): Promise<void> {
    const requestId = job.requestId;
    if (!requestId || job.done || this.destroyed) return;
    await commitPulledFile(this.workspaceId, job.entry, blob);
    if (this.destroyed) return;
    this.completeAttempt(job);
    job.done = true;
    if (job.timer) clearTimeout(job.timer);
    if (job.fileTimer) clearTimeout(job.fileTimer);
    this.jobs.delete(job.key);
    this.setFileStatus(job.entry.fileId, { status: "synced", progress: 1 });
    this.log(
      `sync-pull-complete:${job.entry.fileId}`,
      job.activePeerId ?? undefined,
    );
    void this.updateStateHash().catch((error: unknown) => {
      this.log(
        `sync-state-hash-failed:${readableError(error)}`,
        undefined,
        true,
      );
    });
    this.refreshPeerStates();
    this.pumpPulls();
  }

  private failAttempt(job: PullJob, reason: string): void {
    if (!job.activePeerId) return;
    const peerId = job.activePeerId;
    const requestId = job.requestId;
    this.completeAttempt(job);
    if (requestId) this.adapter.cancelPull(peerId, requestId);
    this.log(`sync-pull-attempt-failed:${reason}`, peerId, true);
    this.retryJob(job, reason);
  }

  private completeAttempt(job: PullJob): void {
    const peerId = job.activePeerId;
    const requestId = job.requestId;
    if (job.fileTimer) clearTimeout(job.fileTimer);
    job.fileTimer = null;
    if (requestId) this.pendingByRequest.delete(requestId);
    if (peerId) {
      this.activePulls = Math.max(0, this.activePulls - 1);
      const nextCount = Math.max(
        0,
        (this.peerActivePulls.get(peerId) ?? 1) - 1,
      );
      if (nextCount === 0) this.peerActivePulls.delete(peerId);
      else this.peerActivePulls.set(peerId, nextCount);
    }
    job.activePeerId = null;
    job.requestId = null;
  }

  private retryJob(job: PullJob, reason: string): void {
    if (this.destroyed || job.done) return;
    if (job.attempts >= MAX_PULL_ATTEMPTS) {
      this.failJob(job, reason);
      return;
    }
    const delay = 1000 * 2 ** Math.max(0, job.attempts - 1);
    this.setFileStatus(job.entry.fileId, {
      status: "queued",
      progress: 0,
      error: reason,
    });
    job.timer = setTimeout(() => {
      job.timer = null;
      if (!this.queue.includes(job)) this.queue.push(job);
      this.pumpPulls();
    }, delay);
    this.refreshPeerStates();
  }

  private failJob(job: PullJob, reason: string): void {
    if (job.activePeerId) this.completeAttempt(job);
    job.done = true;
    if (job.timer) clearTimeout(job.timer);
    if (job.fileTimer) clearTimeout(job.fileTimer);
    const index = this.queue.indexOf(job);
    if (index >= 0) this.queue.splice(index, 1);
    this.setFileStatus(job.entry.fileId, {
      status: "failed",
      progress: 0,
      error: reason,
    });
    this.log(`sync-pull-failed:${job.entry.fileId}:${reason}`, undefined, true);
    this.refreshPeerStates();
    this.pumpPulls();
  }

  private pausePeerPulls(peerId: string): void {
    for (const job of this.jobs.values()) {
      if (job.activePeerId !== peerId || job.finalizing) continue;
      const requestId = job.requestId;
      this.completeAttempt(job);
      if (requestId) this.adapter.cancelPull(peerId, requestId);
      if (job.attempts >= MAX_PULL_ATTEMPTS) {
        this.failJob(job, "Peer disconnected during file transfer");
      } else if (!this.queue.includes(job)) {
        this.queue.unshift(job);
        this.setFileStatus(job.entry.fileId, { status: "queued", progress: 0 });
      }
    }
    this.pumpPulls();
  }

  private setFileStatus(fileId: string, snapshot: FileSyncSnapshot): void {
    useSyncStore.getState().setFile(fileId, snapshot);
  }

  private refreshPeerStates(): void {
    const pending = [...this.jobs.values()].some((job) => !job.done);
    const state: PeerSyncStatus = pending ? "syncing" : "in-sync";
    for (const peerId of this.securePeers) {
      if (this.processedManifestPeers.has(peerId)) {
        useSyncStore.getState().setPeer(peerId, state);
      }
    }
  }

  private addSource(entry: FileEntry, peerId: string): void {
    const job = this.jobs.get(pullKey(entry));
    if (job && !job.sources.includes(peerId)) job.sources.push(peerId);
  }

  async retryFile(fileId: string): Promise<void> {
    const job = [...this.jobs.values()].find(
      (candidate) => candidate.entry.fileId === fileId && candidate.done,
    );
    if (!job) return;
    job.done = false;
    job.attempts = 0;
    job.sourceIndex = 0;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    if (!this.queue.includes(job)) this.queue.push(job);
    this.setFileStatus(fileId, { status: "queued", progress: 0 });
    this.pumpPulls();
  }

  private async forgeViewerDelta(): Promise<void> {
    if (
      process.env.NODE_ENV !== "development" ||
      process.env.NEXT_PUBLIC_DEBUG_FORGE_VIEWER !== "true" ||
      this.getLocalRole() !== "viewer"
    ) {
      return;
    }
    const message = createDeltaMessages([
      {
        fileId: crypto.randomUUID(),
        name: "forged-viewer-entry.txt",
        size: 1,
        sha256: "f".repeat(64),
        lamport: 1,
        author: this.localFingerprint,
        authorName: "Viewer",
        modifiedAt: Date.now(),
        deleted: false,
      },
    ]);
    for (const peerId of this.securePeers) {
      if (this.isEligiblePeer(peerId)) {
        await this.adapter.send(peerId, message);
      }
    }
    this.log("debug-forged-viewer-delta-sent", undefined, true);
  }

  private async updateStateHash(): Promise<void> {
    const library = await readLibrary(this.workspaceId);
    const entries = library.items
      .map((item) => item.entry)
      .sort((a, b) => a.fileId.localeCompare(b.fileId));
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(entries)),
    );
    if (this.destroyed) return;
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    useSyncStore.getState().setStateHash(hash);
    this.log(`sync-state-hash:${hash}`);
  }
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Workspace sync failed";
}
