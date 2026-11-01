import {
  base64ToBytes,
  bytesToBase64,
  bytesEqual,
  buildWorkspaceOfferAad,
  buildSyncInnerAad,
  compareBytes,
  dataChannelMessageSchema,
  deriveSessionKey,
  createWorkspaceProofDigest,
  createSyncId,
  fileControlMessageSchema,
  fingerprintPublicKey,
  helloMessageSchema,
  open,
  readyMessageSchema,
  readyPayloadSchema,
  syncFileOfferSchema,
  seal,
  utf8,
  buildSyncAad,
  parseSyncWire,
  syncPayloadSchema,
  SyncReplayGuard,
  MAX_SYNC_PLAINTEXT_BYTES,
  MAX_SYNC_WIRE_BYTES,
  type ChatMessage,
  type HelloMessage,
  type IdentityAlgorithm,
  type PeerDirectoryEntry,
  type SignalData,
  type WorkspaceRole,
  type SyncHeader,
  type SyncPayload,
} from "@zerocloud/shared";
import { TypedEventEmitter } from "./TypedEventEmitter";
import { FileSender } from "../transfer/FileSender";
import {
  FileReceiver,
  type SyncPullExpectation,
} from "../transfer/FileReceiver";
import type {
  IncomingOffer,
  SyncTransferOptions,
  TransferSnapshot,
} from "../transfer/types";
import type { StoredIdentity } from "../identity/identityStore";
import {
  localToRemoteAad,
  remoteToLocalAad,
  type PeerCryptoContext,
} from "../transfer/cryptoContext";

export type CandidateType = "host" | "srflx" | "relay";
export type HandshakeState =
  "handshaking" | "secure" | "incompatible" | "identity-mismatch" | "failed";
export type WorkspacePeerState =
  | "unverified"
  | "verifying"
  | "verified"
  | "waiting-for-key"
  | "no-access";

export type PeerSnapshot = {
  peerId: string;
  userId: string | null;
  displayName: string | null;
  role: WorkspaceRole | null;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  dataChannelState: RTCDataChannelState | "unavailable";
  candidateType: CandidateType | null;
  failed: boolean;
  handshakeState: HandshakeState;
  algorithm: IdentityAlgorithm | null;
  fingerprint: string | null;
  sameIdentity: boolean;
  verified: boolean;
  handshakeError: string | null;
  workspaceState: WorkspacePeerState;
  workspaceVerifiedVersion: number | null;
};

export type PeerManagerEvents = {
  state: PeerSnapshot;
  removed: { peerId: string };
  message: { peerId: string; message: ChatMessage };
  transfer: TransferSnapshot;
  incomingOffer: IncomingOffer;
  syncMessage: { peerId: string; header: SyncHeader; message: SyncPayload };
  syncRejected: { peerId: string; syncId?: string; reason: string };
  log: {
    at: number;
    level: "info" | "error";
    event: string;
    peerId?: string;
  };
};

type PeerRecord = {
  connection: RTCPeerConnection;
  channel: RTCDataChannel | null;
  pendingCandidates: RTCIceCandidateInit[];
  remoteDescriptionSet: boolean;
  restartAttempted: boolean;
  restartTimer: ReturnType<typeof setTimeout> | null;
  disposed: boolean;
  failed: boolean;
  candidateType: CandidateType | null;
  statsTimer: ReturnType<typeof setInterval>;
  removeListeners: Array<() => void>;
  removeChannelListeners: Array<() => void>;
  handshakeState: HandshakeState;
  helloSent: boolean;
  helloReceived: boolean;
  readySent: boolean;
  readyReceived: boolean;
  localNonce: Uint8Array | null;
  remoteNonce: Uint8Array | null;
  remotePublicKey: Uint8Array | null;
  remoteFingerprint: string | null;
  remoteAlgorithm: IdentityAlgorithm | null;
  sameIdentity: boolean;
  cryptoContext: PeerCryptoContext | null;
  protocolQueue: Promise<void>;
  handshakeError: string | null;
  directory: PeerDirectoryEntry | null;
  syncSendSeq: number;
  syncReceiveGuard: SyncReplayGuard;
  syncSendQueue: Promise<void>;
  workspaceState: WorkspacePeerState;
  workspaceVerifiedVersion: number | null;
  localProofSentVersion: number | null;
  proofSendScheduledVersion: number | null;
  remoteProofVerifiedVersion: number | null;
  waitingTimer: ReturnType<typeof setTimeout> | null;
  keyFetchPromise: Promise<number> | null;
  keyFetchAttempted: boolean;
  accessRevoked: boolean;
};

export type WorkspaceKeyAccess = {
  currentVersion: () => number | undefined;
  get: (version: number) => { syncKey: CryptoKey } | undefined;
  refresh: () => Promise<number>;
};

type SignalSender = (to: string, data: SignalData) => void;
type IceSignal = Extract<SignalData, { kind: "ice" }>;

const STUN_FALLBACK = "stun:stun.l.google.com:19302";
const CHAT_TYPE = "chat";
const SYNC_TYPE = "sync";

function asRtcIceCandidate(
  candidate: IceSignal["candidate"],
): RTCIceCandidateInit {
  return {
    candidate: candidate.candidate,
    ...(candidate.sdpMid === undefined ? {} : { sdpMid: candidate.sdpMid }),
    ...(candidate.sdpMLineIndex === undefined
      ? {}
      : { sdpMLineIndex: candidate.sdpMLineIndex }),
    ...(candidate.usernameFragment === undefined
      ? {}
      : { usernameFragment: candidate.usernameFragment }),
  };
}

function configuredIceServers(): RTCIceServer[] {
  const stunUrls = (process.env.NEXT_PUBLIC_STUN_URLS ?? STUN_FALLBACK)
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
  const servers: RTCIceServer[] = stunUrls.map((urls) => ({ urls }));
  const turnUrls = (process.env.NEXT_PUBLIC_TURN_URL ?? "")
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);

  if (turnUrls.length > 0) {
    const username = process.env.NEXT_PUBLIC_TURN_USERNAME;
    const credential = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;
    servers.push({
      urls: turnUrls,
      ...(username ? { username } : {}),
      ...(credential ? { credential } : {}),
    });
  }

  return servers;
}

export class PeerManager {
  readonly events = new TypedEventEmitter<PeerManagerEvents>();
  private readonly peers = new Map<string, PeerRecord>();
  private readonly senders = new Map<string, FileSender>();
  private readonly receivers = new Map<string, FileReceiver>();
  private readonly nextTransferIds = new Map<string, number>();
  private readonly iceServers = configuredIceServers();

  constructor(
    private readonly localPeerId: string,
    private readonly workspaceId: string,
    private readonly sendSignal: SignalSender,
    private readonly identity: StoredIdentity,
    private readonly verifiedFingerprints: Set<string>,
    private readonly workspaceKeys: WorkspaceKeyAccess,
  ) {}

  get peerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  addPeer(entry: PeerDirectoryEntry): void {
    const peer = this.getOrCreatePeer(entry.peerId);
    peer.directory = entry;
    this.updateState(entry.peerId, peer);
  }

  updateUserRole(userId: string, role: "editor" | "viewer"): void {
    for (const [peerId, peer] of this.peers) {
      if (peer.directory?.userId !== userId) continue;
      peer.directory = { ...peer.directory, role };
      this.updateState(peerId, peer);
    }
  }

  async connectToPeer(peerId: string): Promise<void> {
    const peer = this.getOrCreatePeer(peerId);
    if (peer.connection.signalingState !== "stable") return;

    try {
      if (!peer.channel) {
        this.attachDataChannel(
          peerId,
          peer,
          peer.connection.createDataChannel("zc-data", {
            ordered: true,
          }),
        );
      }
      const offer = await peer.connection.createOffer();
      if (peer.disposed) return;
      await peer.connection.setLocalDescription(offer);
      if (peer.disposed) return;
      if (peer.connection.localDescription?.sdp) {
        this.sendSignal(peerId, {
          kind: "offer",
          sdp: peer.connection.localDescription.sdp,
        });
        this.log("info", "offer-sent", peerId);
      }
    } catch {
      this.log("error", "offer-failed", peerId);
      this.updateState(peerId, peer);
    }
  }

  async handleSignal(peerId: string, data: SignalData): Promise<void> {
    const peer = this.getOrCreatePeer(peerId);
    try {
      if (data.kind === "ice") {
        if (!peer.remoteDescriptionSet) {
          peer.pendingCandidates.push(asRtcIceCandidate(data.candidate));
        } else {
          await peer.connection.addIceCandidate(
            asRtcIceCandidate(data.candidate),
          );
        }
        if (peer.disposed) return;
        this.log("info", "ice-received", peerId);
        return;
      }

      await peer.connection.setRemoteDescription({
        type: data.kind,
        sdp: data.sdp,
      });
      if (peer.disposed) return;
      peer.remoteDescriptionSet = true;
      await this.flushCandidates(peerId, peer);

      if (data.kind === "offer") {
        const answer = await peer.connection.createAnswer();
        if (peer.disposed) return;
        await peer.connection.setLocalDescription(answer);
        if (peer.disposed) return;
        if (peer.connection.localDescription?.sdp) {
          this.sendSignal(peerId, {
            kind: "answer",
            sdp: peer.connection.localDescription.sdp,
          });
          this.log("info", "answer-sent", peerId);
        }
      } else {
        this.log("info", "answer-received", peerId);
      }
      peer.failed = false;
      this.updateState(peerId, peer);
    } catch {
      this.log("error", "signal-processing-failed", peerId);
      this.updateState(peerId, peer);
    }
  }

  get openPeerCount(): number {
    return Array.from(this.peers.values()).filter(
      (peer) => peer.channel?.readyState === "open",
    ).length;
  }

  broadcastText(text: string): { message: ChatMessage; sent: number } {
    const message: ChatMessage = { type: CHAT_TYPE, text, ts: Date.now() };
    const serialized = JSON.stringify(message);
    let sent = 0;

    for (const [peerId, peer] of this.peers) {
      if (
        peer.channel?.readyState !== "open" ||
        peer.handshakeState !== "secure" ||
        !this.isWorkspaceVerified(peer)
      )
        continue;
      try {
        peer.channel.send(serialized);
        sent += 1;
        this.log("info", "chat-sent", peerId);
      } catch {
        this.log("error", "chat-send-failed", peerId);
      }
    }

    return { message, sent };
  }

  sendFile(
    peerId: string,
    file: File,
    options?: SyncTransferOptions,
  ): number | null {
    const peer = this.peers.get(peerId);
    if (
      peer?.channel?.readyState !== "open" ||
      peer.handshakeState !== "secure" ||
      !this.isWorkspaceVerified(peer) ||
      !peer.cryptoContext
    )
      return null;
    const transferId = this.allocateTransferId(peerId);
    this.getSender(peerId, peer.channel, peer.cryptoContext).enqueue(
      file,
      transferId,
      options,
    );
    this.log("info", "file-queued", peerId);
    return transferId;
  }

  async sendSyncPayloads(
    peerId: string,
    messages: SyncPayload[],
  ): Promise<boolean> {
    const peer = this.peers.get(peerId);
    if (
      !peer?.channel ||
      peer.channel.readyState !== "open" ||
      peer.handshakeState !== "secure" ||
      !peer.cryptoContext ||
      !peer.directory?.role ||
      !this.isWorkspaceVerified(peer) ||
      messages.length === 0
    ) {
      return false;
    }
    const task = peer.syncSendQueue.then(async () => {
      if (peer.disposed || peer.channel?.readyState !== "open") return false;
      const keyVersion = this.workspaceKeys.currentVersion();
      if (!keyVersion || peer.workspaceVerifiedVersion !== keyVersion || !this.isWorkspaceVerified(peer)) return false;
      const hasManifest = messages.some(
        (message) => message.type === "manifest",
      );
      const allManifest = messages.every(
        (message) => message.type === "manifest",
      );
      if (hasManifest !== allManifest) {
        throw new Error("A sync send cannot mix manifest and other messages");
      }
      if (allManifest) {
        const fragments = messages.filter(
          (message): message is Extract<SyncPayload, { type: "manifest" }> =>
            message.type === "manifest",
        );
        const first = fragments[0];
        const indexes = new Set(
          fragments.map((fragment) => fragment.partIndex),
        );
        if (
          !first ||
          fragments.length !== first.totalParts ||
          fragments.some(
            (fragment) =>
              fragment.syncId !== first.syncId ||
              fragment.totalParts !== first.totalParts,
          ) ||
          indexes.size !== fragments.length ||
          Array.from({ length: first.totalParts }, (_, index) => index).some(
            (index) => !indexes.has(index),
          )
        ) {
          throw new Error("Manifest fragments must form one complete manifest");
        }
      }
      const groups = allManifest
        ? [messages]
        : messages.map((message) => [message]);
      const context = peer.cryptoContext;
      if (!context) return false;
      for (const group of groups) {
        const seq = peer.syncSendSeq + 1;
        if (seq > 0xffffffff)
          throw new Error("Sync message sequence exhausted");
        peer.syncSendSeq = seq;
        for (const message of group) {
          if (this.workspaceKeys.currentVersion() !== keyVersion || !this.isWorkspaceVerified(peer)) return false;
          const parsed = syncPayloadSchema.safeParse(message);
          if (!parsed.success) throw new Error("Invalid sync payload");
          const partIndex = message.type === "manifest" ? message.partIndex : 0;
          const totalParts =
            message.type === "manifest" ? message.totalParts : 1;
          const header = this.createSyncHeader(peer, message.type, message.syncId, seq, partIndex, totalParts);
          const plaintext = utf8(JSON.stringify(message));
          if (plaintext.byteLength > MAX_SYNC_PLAINTEXT_BYTES) {
            throw new Error("Sync plaintext exceeds 11 KiB");
          }
          const workspaceKey = this.workspaceKeys.get(header.keyVersion);
          if (!workspaceKey) throw new Error("Current workspace sync key is unavailable");
          const innerSealed = await seal(workspaceKey.syncKey, plaintext, buildSyncInnerAad(header));
          const sealed = await seal(context.sessionKey, innerSealed, buildSyncAad(header, context.localFingerprint, context.remoteFingerprint));
          const wire = JSON.stringify({
            type: SYNC_TYPE,
            header,
            sealed: bytesToBase64(sealed),
          });
          if (utf8(wire).byteLength > MAX_SYNC_WIRE_BYTES) {
            throw new Error("Encrypted sync message exceeds 16 KiB");
          }
          if (peer.disposed || peer.channel?.readyState !== "open")
            return false;
          peer.channel.send(wire);
        }
      }
      return true;
    });
    peer.syncSendQueue = task.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await task;
    } catch (error) {
      this.log("error", `sync-send-failed:${readableError(error)}`, peerId);
      return false;
    }
  }

  expectSyncPull(peerId: string, expectation: SyncPullExpectation): boolean {
    const peer = this.peers.get(peerId);
    if (
      !peer?.channel ||
      peer.channel.readyState !== "open" ||
      peer.handshakeState !== "secure" ||
      !peer.cryptoContext ||
      !peer.directory?.role
    ) {
      return false;
    }
    this.getReceiver(peerId, peer.channel, peer.cryptoContext).expectSyncPull(
      expectation,
    );
    return true;
  }

  cancelSyncPull(peerId: string, requestId: string): void {
    this.receivers.get(peerId)?.cancelSyncPull(requestId);
  }

  sendFileToAll(file: File): { peerId: string; transferId: number }[] {
    const results: { peerId: string; transferId: number }[] = [];
    for (const peerId of this.peerIds) {
      const transferId = this.sendFile(peerId, file);
      if (transferId !== null) results.push({ peerId, transferId });
    }
    return results;
  }

  cancelTransfer(
    peerId: string,
    transferId: number,
    direction: "incoming" | "outgoing",
  ): void {
    if (direction === "outgoing") this.senders.get(peerId)?.cancel(transferId);
    else this.receivers.get(peerId)?.cancel(transferId);
  }

  acceptTransfer(peerId: string, transferId: number): void {
    this.receivers.get(peerId)?.accept(transferId);
  }

  markMemberRemoved(userId: string): void {
    for (const [peerId, peer] of this.peers) {
      if (peer.directory?.userId !== userId) continue;
      peer.accessRevoked = true;
      peer.workspaceState = "no-access";
      peer.workspaceVerifiedVersion = null;
      peer.localProofSentVersion = null;
      peer.remoteProofVerifiedVersion = null;
      this.senders.get(peerId)?.cancelAll("No workspace access");
      this.receivers.get(peerId)?.dispose("No workspace access");
      this.receivers.delete(peerId);
      this.updateState(peerId, peer);
      this.log("error", "no-workspace-access", peerId);
    }
  }

  workspaceKeyUpdated(): void {
    for (const [peerId, peer] of this.peers) {
      if (peer.handshakeState !== "secure" || peer.accessRevoked) continue;
      this.resetWorkspaceProof(peer);
      this.updateState(peerId, peer);
      void this.sendWorkspaceProof(peerId, peer);
    }
  }

  workspaceRotationAnnounced(version: number): void {
    for (const [peerId, peer] of this.peers) {
      if (peer.handshakeState !== "secure" || peer.accessRevoked) continue;
      this.resetWorkspaceProof(peer);
      peer.workspaceState = "verifying";
      this.senders.get(peerId)?.cancelAll("Workspace key rotated");
      this.updateState(peerId, peer);
    }
    this.log("info", `workspace-rotation-announced:${version}`);
  }

  workspaceAccessLost(): void {
    for (const [peerId, peer] of this.peers) {
      peer.accessRevoked = true;
      this.markNoWorkspaceAccess(peerId, peer, "workspace-access-lost");
    }
  }
  declineTransfer(peerId: string, transferId: number): void {
    this.receivers.get(peerId)?.decline(transferId);
  }

  setFingerprintVerified(fingerprint: string): void {
    this.verifiedFingerprints.add(fingerprint);
    for (const [peerId, peer] of this.peers) this.updateState(peerId, peer);
  }

  removePeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.disposePeer(peer);
    this.senders.get(peerId)?.dispose();
    this.receivers.get(peerId)?.dispose();
    this.senders.delete(peerId);
    this.receivers.delete(peerId);
    this.peers.delete(peerId);
    this.events.emit("removed", { peerId });
  }

  closeAll(): void {
    for (const peerId of this.peerIds) this.removePeer(peerId);
  }

  destroy(): void {
    this.closeAll();
    this.events.clear();
  }

  private getOrCreatePeer(peerId: string): PeerRecord {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const connection = new RTCPeerConnection({
      iceServers: this.iceServers,
      ...(process.env.NEXT_PUBLIC_FORCE_RELAY === "true"
        ? { iceTransportPolicy: "relay" as const }
        : {}),
    });
    const peer: PeerRecord = {
      connection,
      channel: null,
      pendingCandidates: [],
      remoteDescriptionSet: false,
      restartAttempted: false,
      restartTimer: null,
      disposed: false,
      failed: false,
      candidateType: null,
      statsTimer: setInterval(() => {
        void this.refreshCandidateType(peerId, peer);
      }, 2500),
      removeListeners: [],
      removeChannelListeners: [],
      handshakeState: "handshaking",
      helloSent: false,
      helloReceived: false,
      readySent: false,
      readyReceived: false,
      localNonce: null,
      remoteNonce: null,
      remotePublicKey: null,
      remoteFingerprint: null,
      remoteAlgorithm: null,
      sameIdentity: false,
      cryptoContext: null,
      protocolQueue: Promise.resolve(),
      handshakeError: null,
      directory: null,
      syncSendSeq: 0,
      syncReceiveGuard: new SyncReplayGuard(),
      syncSendQueue: Promise.resolve(),
      workspaceState: "unverified",
      workspaceVerifiedVersion: null,
      localProofSentVersion: null,
      proofSendScheduledVersion: null,
      remoteProofVerifiedVersion: null,
      waitingTimer: null,
      keyFetchPromise: null,
      keyFetchAttempted: false,
      accessRevoked: false,
    };
    this.peers.set(peerId, peer);

    const onIceCandidate = (event: RTCPeerConnectionIceEvent): void => {
      if (!event.candidate) return;
      this.sendSignal(peerId, {
        kind: "ice",
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment,
        },
      });
      this.log("info", "ice-sent", peerId);
    };
    const onDataChannel = (event: RTCDataChannelEvent): void => {
      this.attachDataChannel(peerId, peer, event.channel);
    };
    const onConnectionStateChange = (): void => {
      if (connection.connectionState === "connected") {
        peer.failed = false;
        if (peer.restartTimer) clearTimeout(peer.restartTimer);
        peer.restartTimer = null;
      }
      this.log("info", `connection-${connection.connectionState}`, peerId);
      this.updateState(peerId, peer);
    };
    const onIceConnectionStateChange = (): void => {
      const state = connection.iceConnectionState;
      this.log("info", `ice-${state}`, peerId);
      if (state === "failed") {
        if (this.isRestartOwner(peerId)) {
          void this.restartIce(peerId, peer);
        } else {
          peer.failed = true;
          this.log("info", "ice-failed-awaiting-restart", peerId);
        }
      }
      if (state === "connected" || state === "completed") {
        peer.failed = false;
        if (peer.restartTimer) clearTimeout(peer.restartTimer);
        peer.restartTimer = null;
      }
      this.updateState(peerId, peer);
      void this.refreshCandidateType(peerId, peer);
    };

    connection.addEventListener("icecandidate", onIceCandidate);
    connection.addEventListener("datachannel", onDataChannel);
    connection.addEventListener(
      "connectionstatechange",
      onConnectionStateChange,
    );
    connection.addEventListener(
      "iceconnectionstatechange",
      onIceConnectionStateChange,
    );
    peer.removeListeners.push(
      () => connection.removeEventListener("icecandidate", onIceCandidate),
      () => connection.removeEventListener("datachannel", onDataChannel),
      () =>
        connection.removeEventListener(
          "connectionstatechange",
          onConnectionStateChange,
        ),
      () =>
        connection.removeEventListener(
          "iceconnectionstatechange",
          onIceConnectionStateChange,
        ),
    );

    this.log("info", "peer-created", peerId);
    this.updateState(peerId, peer);
    return peer;
  }

  private attachDataChannel(
    peerId: string,
    peer: PeerRecord,
    channel: RTCDataChannel,
  ): void {
    for (const removeListener of peer.removeChannelListeners.splice(0)) {
      removeListener();
    }
    if (peer.channel && peer.channel !== channel) {
      this.senders.get(peerId)?.dispose("DataChannel replaced");
      this.receivers.get(peerId)?.dispose("DataChannel replaced");
      this.senders.delete(peerId);
      this.receivers.delete(peerId);
      peer.channel.close();
    }
    peer.channel = channel;
    channel.binaryType = "arraybuffer";
    peer.handshakeState = "handshaking";
    peer.helloSent = false;
    peer.helloReceived = false;
    peer.readySent = false;
    peer.readyReceived = false;
    peer.localNonce = null;
    peer.remoteNonce = null;
    peer.remotePublicKey = null;
    peer.remoteFingerprint = null;
    peer.remoteAlgorithm = null;
    peer.sameIdentity = false;
    peer.cryptoContext = null;
    peer.handshakeError = null;
    peer.protocolQueue = Promise.resolve();
    peer.syncSendSeq = 0;
    peer.syncReceiveGuard = new SyncReplayGuard();
    peer.syncSendQueue = Promise.resolve();
    this.resetWorkspaceProof(peer);

    const onOpen = (): void => {
      this.log("info", "datachannel-open", peerId);
      void this.beginHandshake(peerId, peer);
      this.updateState(peerId, peer);
    };
    const onClose = (): void => {
      this.log("info", "datachannel-closed", peerId);
      this.senders.get(peerId)?.dispose("DataChannel closed");
      this.receivers.get(peerId)?.dispose("DataChannel closed");
      this.senders.delete(peerId);
      this.receivers.delete(peerId);
      this.updateState(peerId, peer);
    };
    const onMessage = (event: MessageEvent): void => {
      if (event.data instanceof ArrayBuffer) {
        if (!this.isWorkspaceVerified(peer)) return;
        const receiver = this.receivers.get(peerId);
        if (receiver) void receiver.handleBinary(event.data);
        else
          this.log("error", "encrypted-chunk-before-secure-handshake", peerId);
        return;
      }
      if (event.data instanceof Blob) {
        void event.data
          .arrayBuffer()
          .then((buffer) => {
            if (this.isWorkspaceVerified(peer)) return this.receivers.get(peerId)?.handleBinary(buffer);
          });
        return;
      }
      if (typeof event.data !== "string") return;
      peer.protocolQueue = peer.protocolQueue
        .then(() => this.handleStringMessage(peerId, peer, event.data))
        .catch((error: unknown) =>
          this.failHandshake(peerId, peer, readableError(error)),
        );
    };
    const onError = (): void => {
      this.log("error", "datachannel-error", peerId);
    };

    channel.addEventListener("open", onOpen);
    channel.addEventListener("close", onClose);
    channel.addEventListener("message", onMessage);
    channel.addEventListener("error", onError);
    peer.removeChannelListeners.push(
      () => channel.removeEventListener("open", onOpen),
      () => channel.removeEventListener("close", onClose),
      () => channel.removeEventListener("message", onMessage),
      () => channel.removeEventListener("error", onError),
    );
    this.updateState(peerId, peer);
    if (channel.readyState === "open") void this.beginHandshake(peerId, peer);
  }

  private getSender(
    peerId: string,
    channel: RTCDataChannel,
    context: PeerCryptoContext,
  ): FileSender {
    const current = this.senders.get(peerId);
    if (current) return current;
    const peer = this.peers.get(peerId);
    if (!peer) throw new Error("Peer record is unavailable");
    const sender = new FileSender(peerId, channel, context, (offer) => this.wrapSyncOffer(peerId, peer, offer));
    sender.events.on("transfer", (transfer) =>
      this.events.emit("transfer", transfer),
    );
    sender.events.on("log", ({ peerId: from, event, error }) =>
      this.log(error ? "error" : "info", event, from),
    );
    this.senders.set(peerId, sender);
    return sender;
  }

  private getReceiver(
    peerId: string,
    channel: RTCDataChannel,
    context: PeerCryptoContext,
  ): FileReceiver {
    const current = this.receivers.get(peerId);
    if (current) return current;
    const receiver = new FileReceiver(
      peerId,
      channel,
      context,
      () => this.peers.get(peerId)?.directory?.role ?? null,
    );
    receiver.events.on("transfer", (transfer) =>
      this.events.emit("transfer", transfer),
    );
    receiver.events.on("offer", (offer) =>
      this.events.emit("incomingOffer", offer),
    );
    receiver.events.on("log", ({ peerId: from, event, error }) =>
      this.log(error ? "error" : "info", event, from),
    );
    this.receivers.set(peerId, receiver);
    return receiver;
  }

  private allocateTransferId(peerId: string): number {
    const firstId = this.localPeerId < peerId ? 1 : 2;
    const value = this.nextTransferIds.get(peerId) ?? firstId;
    this.nextTransferIds.set(peerId, value > 0xfffffffd ? firstId : value + 2);
    return value;
  }

  private async beginHandshake(
    peerId: string,
    peer: PeerRecord,
  ): Promise<void> {
    if (peer.helloSent || peer.disposed || peer.channel?.readyState !== "open")
      return;
    try {
      peer.localNonce = crypto.getRandomValues(new Uint8Array(32));
      peer.helloSent = true;
      peer.handshakeState = "handshaking";
      const hello: HelloMessage = {
        type: "hello",
        v: 1,
        alg: this.identity.algorithm,
        publicKey: bytesToBase64(this.identity.publicKeyRaw),
        nonce: bytesToBase64(peer.localNonce),
      };
      peer.channel.send(JSON.stringify(hello));
      this.log("info", `hello-sent:${hello.alg}`, peerId);
      this.updateState(peerId, peer);
    } catch (error) {
      this.failHandshake(peerId, peer, readableError(error));
    }
  }

  private isWorkspaceVerified(peer: PeerRecord): boolean {
    const currentVersion = this.workspaceKeys.currentVersion();
    return Boolean(
      currentVersion &&
        peer.workspaceState === "verified" &&
        peer.workspaceVerifiedVersion === currentVersion &&
        !peer.accessRevoked,
    );
  }

  private resetWorkspaceProof(peer: PeerRecord): void {
    if (peer.waitingTimer) clearTimeout(peer.waitingTimer);
    peer.waitingTimer = null;
    peer.localProofSentVersion = null;
    peer.proofSendScheduledVersion = null;
    peer.remoteProofVerifiedVersion = null;
    peer.workspaceVerifiedVersion = null;
    peer.workspaceState = peer.handshakeState === "secure" ? "verifying" : "unverified";
    peer.keyFetchAttempted = false;
    peer.keyFetchPromise = null;
  }

  private createSyncHeader(
    peer: PeerRecord,
    messageType: SyncHeader["messageType"],
    syncId: string,
    seq: number,
    partIndex = 0,
    totalParts = 1,
  ): SyncHeader {
    const keyVersion = this.workspaceKeys.currentVersion();
    if (!keyVersion) throw new Error("Workspace key version is unavailable");
    return {
      v: 1,
      messageType,
      workspaceId: this.workspaceId,
      keyVersion,
      syncId,
      partIndex,
      totalParts,
      seq,
    };
  }

  private nextSyncSeq(peer: PeerRecord): number {
    const seq = peer.syncSendSeq + 1;
    if (seq > 0xffffffff) throw new Error("Sync message sequence exhausted");
    peer.syncSendSeq = seq;
    return seq;
  }

  private async sendWorkspaceProof(peerId: string, peer: PeerRecord): Promise<void> {
    const version = this.workspaceKeys.currentVersion();
    const keySet = version ? this.workspaceKeys.get(version) : undefined;
    if (version && !keySet && !peer.accessRevoked) {
      this.markNoWorkspaceAccess(peerId, peer, "workspace-sync-key-unavailable");
      return;
    }
    const context = peer.cryptoContext;
    if (
      !version || !keySet || !context || !peer.localNonce || !peer.remoteNonce ||
      peer.handshakeState !== "secure" || peer.disposed || peer.accessRevoked ||
      peer.channel?.readyState !== "open" || peer.localProofSentVersion === version || peer.proofSendScheduledVersion === version
    ) return;

    peer.workspaceState = "verifying";
    peer.workspaceVerifiedVersion = null;
    peer.proofSendScheduledVersion = version;
    const task = peer.syncSendQueue.then(async () => {
      if (peer.disposed || peer.channel?.readyState !== "open" || this.workspaceKeys.currentVersion() !== version) return;
      const header = this.createSyncHeader(peer, "ws-proof", createSyncId(), this.nextSyncSeq(peer));
      const digest = await createWorkspaceProofDigest(
        context.localNonce,
        context.remoteNonce,
        context.localFingerprint,
        context.remoteFingerprint,
      );
      const inner = await seal(keySet.syncKey, digest, buildSyncInnerAad(header));
      const outer = await seal(
        context.sessionKey,
        inner,
        buildSyncAad(header, context.localFingerprint, context.remoteFingerprint),
      );
      if (peer.disposed || peer.channel?.readyState !== "open") return;
      peer.channel.send(JSON.stringify({ type: SYNC_TYPE, header, sealed: bytesToBase64(outer) }));
      peer.localProofSentVersion = version;
      if (peer.proofSendScheduledVersion === version) peer.proofSendScheduledVersion = null;
      this.log("info", `workspace-proof-sent:${version}`, peerId);
      this.updateWorkspaceVerified(peerId, peer, version);
    });
    peer.syncSendQueue = task.then(() => undefined, () => undefined);
    try {
      await task;
      if (peer.proofSendScheduledVersion === version && peer.localProofSentVersion !== version) {
        peer.proofSendScheduledVersion = null;
      }
    } catch (error) {
      if (peer.proofSendScheduledVersion === version) peer.proofSendScheduledVersion = null;
      this.markNoWorkspaceAccess(peerId, peer, `workspace-proof-send-failed:${readableError(error)}`);
    }
  }

  private updateWorkspaceVerified(peerId: string, peer: PeerRecord, version: number): void {
    if (
      peer.localProofSentVersion !== version ||
      peer.remoteProofVerifiedVersion !== version ||
      this.workspaceKeys.currentVersion() !== version
    ) {
      this.updateState(peerId, peer);
      return;
    }
    if (peer.waitingTimer) clearTimeout(peer.waitingTimer);
    peer.waitingTimer = null;
    peer.workspaceState = "verified";
    peer.workspaceVerifiedVersion = version;
    this.log("info", `workspace-verified:${version}`, peerId);
    this.updateState(peerId, peer);
  }

  private waitForWorkspaceKey(peerId: string, peer: PeerRecord): void {
    if (peer.accessRevoked) {
      peer.workspaceState = "no-access";
      peer.workspaceVerifiedVersion = null;
      this.updateState(peerId, peer);
      return;
    }
    peer.workspaceState = "waiting-for-key";
    peer.workspaceVerifiedVersion = null;
    if (peer.waitingTimer) clearTimeout(peer.waitingTimer);
    peer.waitingTimer = setTimeout(() => {
      if (peer.workspaceState !== "verified" && !peer.disposed) {
        peer.workspaceState = "no-access";
        peer.workspaceVerifiedVersion = null;
        this.log("error", "workspace-key-wait-expired", peerId);
        this.updateState(peerId, peer);
      }
    }, 30_000);
    this.updateState(peerId, peer);
  }

  private markNoWorkspaceAccess(peerId: string, peer: PeerRecord, event: string): void {
    if (peer.waitingTimer) clearTimeout(peer.waitingTimer);
    peer.waitingTimer = null;
    peer.workspaceState = "no-access";
    peer.workspaceVerifiedVersion = null;
    this.senders.get(peerId)?.cancelAll("No workspace access");
    this.receivers.get(peerId)?.dispose("No workspace access");
    this.receivers.delete(peerId);
    this.log("error", event, peerId);
    this.updateState(peerId, peer);
  }

  private async fetchWorkspaceKeys(
    peerId: string,
    peer: PeerRecord,
    version: number,
  ): Promise<boolean> {
    if (this.workspaceKeys.get(version)) return true;
    if (peer.keyFetchPromise) {
      try {
        await peer.keyFetchPromise;
      } catch {
        return false;
      }
      return Boolean(this.workspaceKeys.get(version));
    }
    if (peer.keyFetchAttempted) return false;
    peer.keyFetchAttempted = true;
    const refresh = this.workspaceKeys.refresh();
    peer.keyFetchPromise = refresh;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const refreshedVersion = await Promise.race([
        refresh,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error("Workspace key fetch timed out")), 10_000);
        }),
      ]);
      if (refreshedVersion >= version && this.workspaceKeys.get(version)) {
        this.log("info", `workspace-key-fetch-complete:${refreshedVersion}`, peerId);
        return true;
      }
      return false;
    } catch (error) {
      this.log("error", `workspace-key-fetch-failed:${readableError(error)}`, peerId);
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
      peer.keyFetchPromise = null;
    }
  }

  private async sendStaleKey(peerId: string, peer: PeerRecord): Promise<void> {
    const version = this.workspaceKeys.currentVersion();
    const context = peer.cryptoContext;
    if (!version || !context || peer.channel?.readyState !== "open" || peer.accessRevoked) return;
    this.waitForWorkspaceKey(peerId, peer);
    const task = peer.syncSendQueue.then(async () => {
      const header = this.createSyncHeader(peer, "stale-key", createSyncId(), this.nextSyncSeq(peer));
      const sealed = await seal(
        context.sessionKey,
        new Uint8Array(),
        buildSyncAad(header, context.localFingerprint, context.remoteFingerprint),
      );
      if (peer.channel?.readyState === "open" && !peer.disposed) {
        peer.channel.send(JSON.stringify({ type: SYNC_TYPE, header, sealed: bytesToBase64(sealed) }));
      }
    });
    peer.syncSendQueue = task.then(() => undefined, () => undefined);
    await task;
  }

  private async wrapSyncOffer(peerId: string, peer: PeerRecord, offer: import("@zerocloud/shared").FileOfferMessage): Promise<string> {
    const version = this.workspaceKeys.currentVersion();
    const keySet = version ? this.workspaceKeys.get(version) : undefined;
    const context = peer.cryptoContext;
    if (!version || !keySet || !context || !this.isWorkspaceVerified(peer)) {
      throw new Error("Peer is not workspace-verified for sync transfer");
    }
    const sealed = await seal(
      keySet.syncKey,
      utf8(JSON.stringify(offer)),
      buildWorkspaceOfferAad(this.workspaceId, version, offer.transferId, context.localFingerprint, context.remoteFingerprint),
    );
    this.log("info", `sync-file-offer-sealed:${version}`, peerId);
    return JSON.stringify({ type: "sync-file-offer", keyVersion: version, transferId: offer.transferId, sealed: bytesToBase64(sealed) });
  }

  private async handleStringMessage(
    peerId: string,
    peer: PeerRecord,
    raw: string,
  ): Promise<void> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (isRecord(decoded) && decoded.type === SYNC_TYPE) {
      await this.handleSyncWire(peerId, peer, raw);
      return;
    }
    if (isRecord(decoded) && decoded.type === "sync-file-offer") {
      await this.handleSyncOffer(peerId, peer, decoded);
      return;
    }
    if (peer.handshakeState === "identity-mismatch") return;
    if (isRecord(decoded) && decoded.type === "hello") {
      if (peer.helloReceived)
        return this.failHandshake(
          peerId,
          peer,
          "Second hello received on this DataChannel",
        );
      peer.helloReceived = true;
      const parsedHello = helloMessageSchema.safeParse(decoded);
      if (!parsedHello.success)
        return this.failHandshake(
          peerId,
          peer,
          "Invalid handshake hello message",
        );
      await this.handleHello(peerId, peer, parsedHello.data);
      return;
    }
    if (isRecord(decoded) && decoded.type === "ready") {
      const parsedReady = readyMessageSchema.safeParse(decoded);
      if (!parsedReady.success)
        return this.failHandshake(
          peerId,
          peer,
          "Invalid handshake ready message",
        );
      await this.handleReady(peerId, peer, parsedReady.data.sealed);
      return;
    }

    const parsed = dataChannelMessageSchema.safeParse(decoded);
    if (!parsed.success) return;
    if (parsed.data.type === "chat") {
      if (peer.handshakeState !== "secure" || !this.isWorkspaceVerified(peer)) return;
      this.events.emit("message", { peerId, message: parsed.data });
      this.log("info", "chat-received", peerId);
      return;
    }
    const control = fileControlMessageSchema.safeParse(parsed.data);
    if (!control.success) return;
    if (peer.handshakeState !== "secure" || !peer.cryptoContext || !this.isWorkspaceVerified(peer)) {
      this.log("error", "file-control-before-secure-handshake", peerId);
      return;
    }
    const message = control.data;
    if (
      message.type === "file-accept" ||
      message.type === "file-reject" ||
      message.type === "file-ack" ||
      message.type === "file-cancel"
    ) {
      this.senders.get(peerId)?.handleControl(message);
    }
    if (
      message.type === "file-offer" ||
      message.type === "file-complete" ||
      message.type === "file-cancel"
    ) {
      const receiver = this.getReceiver(
        peerId,
        peer.channel!,
        peer.cryptoContext,
      );
      await receiver.handleString(raw);
    }
  }

  private async handleSyncWire(
    peerId: string,
    peer: PeerRecord,
    raw: string,
  ): Promise<void> {
    const parsed = parseSyncWire(raw, this.workspaceId);
    if (!parsed.ok) {
      if (parsed.reason === "workspace") return;
      const reason =
        parsed.reason === "oversize"
          ? "Sync wire message exceeds 16 KiB"
          : "Invalid sync envelope header";
      this.events.emit("syncRejected", { peerId, reason });
      this.log("error", "sync-envelope-invalid", peerId);
      return;
    }
    if (peer.accessRevoked) {
      peer.workspaceState = "no-access";
      this.updateState(peerId, peer);
      return;
    }
    const { header, sealed } = parsed.message;
    if (peer.handshakeState !== "secure" || !peer.cryptoContext || !peer.directory?.role) {
      this.events.emit("syncRejected", {
        peerId,
        syncId: header.syncId,
        reason: "Sync requires a secure peer with a known role",
      });
      return;
    }
    if (!peer.syncReceiveGuard.canAccept(header)) {
      this.log("info", "sync-replay-rejected", peerId);
      return;
    }
    try {
      const context = peer.cryptoContext;
      const outerPlaintext = await open(
        context.sessionKey,
        base64ToBytes(sealed),
        buildSyncAad(header, context.remoteFingerprint, context.localFingerprint),
      );

      if (header.messageType === "stale-key") {
        if (outerPlaintext.byteLength !== 0) throw new Error("Stale-key message must have an empty plaintext");
        peer.syncReceiveGuard.accept(header);
        const currentVersion = this.workspaceKeys.currentVersion();
        if (!currentVersion) return this.markNoWorkspaceAccess(peerId, peer, "workspace-key-unavailable");
        if (header.keyVersion > currentVersion) {
          this.waitForWorkspaceKey(peerId, peer);
          const fetched = await this.fetchWorkspaceKeys(peerId, peer, header.keyVersion);
          if (fetched) {
            this.resetWorkspaceProof(peer);
            await this.sendWorkspaceProof(peerId, peer);
          } else this.waitForWorkspaceKey(peerId, peer);
        } else {
          this.waitForWorkspaceKey(peerId, peer);
        }
        this.log("info", `stale-key-received:${header.keyVersion}`, peerId);
        return;
      }

      const currentVersion = this.workspaceKeys.currentVersion();
      if (!currentVersion) return this.markNoWorkspaceAccess(peerId, peer, "workspace-key-unavailable");
      if (header.messageType === "ws-proof") {
        if (header.keyVersion < currentVersion) {
          peer.syncReceiveGuard.accept(header);
          await this.sendStaleKey(peerId, peer);
          return;
        }
        if (header.keyVersion > currentVersion) {
          this.waitForWorkspaceKey(peerId, peer);
          const fetched = await this.fetchWorkspaceKeys(peerId, peer, header.keyVersion);
          if (!fetched) {
            await this.sendStaleKey(peerId, peer);
            this.waitForWorkspaceKey(peerId, peer);
            return;
          }
          const refreshedVersion = this.workspaceKeys.currentVersion();
          if (refreshedVersion !== header.keyVersion) {
            await this.sendStaleKey(peerId, peer);
            return;
          }
        }
        const keySet = this.workspaceKeys.get(header.keyVersion);
        if (!keySet || !peer.localNonce || !peer.remoteNonce) {
          await this.sendStaleKey(peerId, peer);
          return;
        }
        const proof = await open(keySet.syncKey, new Uint8Array(outerPlaintext), buildSyncInnerAad(header));
        const expected = await createWorkspaceProofDigest(
          context.remoteNonce,
          context.localNonce,
          context.remoteFingerprint,
          context.localFingerprint,
        );
        if (!bytesEqual(proof, expected)) throw new Error("Workspace proof is invalid or reflected");
        peer.syncReceiveGuard.accept(header);
        peer.remoteProofVerifiedVersion = header.keyVersion;
        peer.workspaceState = "verifying";
        this.log("info", `workspace-proof-verified:${header.keyVersion}`, peerId);
        if (peer.localProofSentVersion !== header.keyVersion) await this.sendWorkspaceProof(peerId, peer);
        this.updateWorkspaceVerified(peerId, peer, header.keyVersion);
        return;
      }

      if (header.keyVersion > currentVersion) {
        this.waitForWorkspaceKey(peerId, peer);
        const fetched = await this.fetchWorkspaceKeys(peerId, peer, header.keyVersion);
        if (fetched) {
          this.resetWorkspaceProof(peer);
          await this.sendWorkspaceProof(peerId, peer);
        } else {
          this.waitForWorkspaceKey(peerId, peer);
        }
        return;
      }
      if (header.keyVersion < currentVersion) {
        await this.sendStaleKey(peerId, peer);
        return;
      }
      if (header.keyVersion !== peer.workspaceVerifiedVersion) {
        await this.sendStaleKey(peerId, peer);
        return;
      }
      if (!this.isWorkspaceVerified(peer)) return;
      const keySet = this.workspaceKeys.get(header.keyVersion);
      if (!keySet) return this.markNoWorkspaceAccess(peerId, peer, "workspace-sync-key-unavailable");
      const plaintext = await open(keySet.syncKey, new Uint8Array(outerPlaintext), buildSyncInnerAad(header));
      if (plaintext.byteLength > MAX_SYNC_PLAINTEXT_BYTES) throw new Error("Sync inner plaintext exceeds 11 KiB");
      const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      const message = syncPayloadSchema.parse(decoded);
      if (
        message.type !== header.messageType ||
        message.syncId !== header.syncId ||
        (message.type === "manifest" &&
          (message.partIndex !== header.partIndex ||
            message.totalParts !== header.totalParts)) ||
        (message.type !== "manifest" &&
          (header.partIndex !== 0 || header.totalParts !== 1))
      ) {
        throw new Error("Sync payload does not match its authenticated header");
      }
      peer.syncReceiveGuard.accept(header);
      this.events.emit("syncMessage", { peerId, header, message });
    } catch (error) {
      peer.syncReceiveGuard.discardManifest(header.syncId);
      this.events.emit("syncRejected", {
        peerId,
        syncId: header.syncId,
        reason: readableError(error),
      });
      this.log("error", "sync-authentication-failed", peerId);
      if (header.messageType === "ws-proof") this.markNoWorkspaceAccess(peerId, peer, "workspace-proof-failed");
    }
  }

  private async handleSyncOffer(peerId: string, peer: PeerRecord, raw: unknown): Promise<void> {
    const parsed = syncFileOfferSchema.safeParse(raw);
    if (!parsed.success || !peer.cryptoContext || peer.handshakeState !== "secure") return;
    if (peer.accessRevoked) return;
    const envelope = parsed.data;
    const currentVersion = this.workspaceKeys.currentVersion();
    if (!currentVersion || envelope.keyVersion !== currentVersion || !this.isWorkspaceVerified(peer)) {
      if (currentVersion && envelope.keyVersion > currentVersion) {
        this.waitForWorkspaceKey(peerId, peer);
        const fetched = await this.fetchWorkspaceKeys(peerId, peer, envelope.keyVersion);
        if (!fetched) this.waitForWorkspaceKey(peerId, peer);
      } else if (currentVersion && envelope.keyVersion < currentVersion) {
        await this.sendStaleKey(peerId, peer);
      }
      this.log("error", `sync-offer-version-rejected:${envelope.keyVersion}`, peerId);
      return;
    }
    const keySet = this.workspaceKeys.get(envelope.keyVersion);
    if (!keySet) return;
    try {
      const plaintext = await open(
        keySet.syncKey,
        base64ToBytes(envelope.sealed),
        buildWorkspaceOfferAad(this.workspaceId, envelope.keyVersion, envelope.transferId, peer.cryptoContext.remoteFingerprint, peer.cryptoContext.localFingerprint),
      );
      const offerValue: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      const offer = fileControlMessageSchema.safeParse(offerValue);
      if (!offer.success || offer.data.type !== "file-offer" || offer.data.transferId !== envelope.transferId) {
        throw new Error("Sync file offer does not match its authenticated header");
      }
      const receiver = this.getReceiver(peerId, peer.channel!, peer.cryptoContext);
      await receiver.handleString(JSON.stringify(offer.data));
    } catch (error) {
      this.log("error", `sync-file-offer-authentication-failed:${readableError(error)}`, peerId);
    }
  }

  private async handleHello(
    peerId: string,
    peer: PeerRecord,
    hello: HelloMessage,
  ): Promise<void> {
    if (!peer.helloSent) await this.beginHandshake(peerId, peer);
    peer.remoteAlgorithm = hello.alg;
    if (hello.alg !== this.identity.algorithm) {
      peer.handshakeState = "incompatible";
      peer.handshakeError = `Peer uses ${hello.alg}; this browser uses ${this.identity.algorithm}`;
      this.log("error", `incompatible-curve:${hello.alg}`, peerId);
      this.updateState(peerId, peer);
      return;
    }
    try {
      const remoteNonce = base64ToBytes(hello.nonce);
      const remotePublicKey = base64ToBytes(hello.publicKey);
      if (remoteNonce.length !== 32)
        throw new Error("Handshake nonce must be 32 bytes");
      const expectedKeyLength = hello.alg === "X25519" ? 32 : 65;
      if (remotePublicKey.length !== expectedKeyLength)
        throw new Error("Handshake public key has an invalid length");
      if (!peer.localNonce)
        throw new Error("Local handshake nonce is unavailable");
      if (compareBytes(peer.localNonce, remoteNonce) === 0)
        throw new Error("Handshake nonces must be unique");
      peer.remoteNonce = remoteNonce;
      peer.remotePublicKey = remotePublicKey;
      peer.remoteFingerprint = await fingerprintPublicKey(remotePublicKey);
      if (peer.directory?.fingerprint !== peer.remoteFingerprint) {
        peer.handshakeState = "identity-mismatch";
        peer.failed = true;
        peer.handshakeError = "Identity mismatch with workspace directory";
        this.log("error", "identity-mismatch", peerId);
        this.updateState(peerId, peer);
        return;
      }
      peer.sameIdentity = peer.remoteFingerprint === this.identity.fingerprint;
      const sessionKey = await deriveSessionKey({
        algorithm: hello.alg,
        privateKey: this.identity.privateKey,
        localPublicKey: this.identity.publicKeyRaw,
        remotePublicKey,
        localNonce: peer.localNonce,
        remoteNonce,
      });
      peer.cryptoContext = {
        sessionKey,
        localFingerprint: this.identity.fingerprint,
        remoteFingerprint: peer.remoteFingerprint,
        localNonce: peer.localNonce,
        remoteNonce,
      };
      const readyPlaintext = utf8(JSON.stringify({ type: "ready", v: 1 }));
      const sealed = await seal(
        sessionKey,
        readyPlaintext,
        localToRemoteAad(peer.cryptoContext, "ready"),
      );
      if (peer.channel?.readyState !== "open")
        throw new Error("DataChannel closed during handshake");
      peer.channel.send(
        JSON.stringify({ type: "ready", sealed: bytesToBase64(sealed) }),
      );
      peer.readySent = true;
      this.log("info", "ready-sent", peerId);
      this.updateState(peerId, peer);
    } catch (error) {
      this.failHandshake(peerId, peer, readableError(error));
    }
  }

  private async handleReady(
    peerId: string,
    peer: PeerRecord,
    sealedBase64: string,
  ): Promise<void> {
    if (!peer.cryptoContext || peer.handshakeState !== "handshaking") {
      return this.failHandshake(
        peerId,
        peer,
        "Ready received before handshake derivation",
      );
    }
    if (peer.readyReceived)
      return this.failHandshake(
        peerId,
        peer,
        "Duplicate ready message received",
      );
    try {
      const plaintext = await open(
        peer.cryptoContext.sessionKey,
        base64ToBytes(sealedBase64),
        remoteToLocalAad(peer.cryptoContext, "ready"),
      );
      const payload: unknown = JSON.parse(new TextDecoder().decode(plaintext));
      if (!readyPayloadSchema.safeParse(payload).success)
        throw new Error("Invalid ready confirmation");
      peer.readyReceived = true;
      peer.handshakeState = "secure";
      const channel = peer.channel;
      if (!channel || channel.readyState !== "open")
        throw new Error("DataChannel closed during handshake");
      this.getSender(peerId, channel, peer.cryptoContext);
      this.getReceiver(peerId, channel, peer.cryptoContext);
      this.log("info", "handshake-secure", peerId);
      peer.workspaceState = "verifying";
      this.updateState(peerId, peer);
      await this.sendWorkspaceProof(peerId, peer);
    } catch (error) {
      this.failHandshake(peerId, peer, readableError(error));
    }
  }

  private failHandshake(
    peerId: string,
    peer: PeerRecord,
    reason: string,
  ): void {
    peer.handshakeState = "failed";
    peer.handshakeError = reason;
    peer.cryptoContext = null;
    this.senders.get(peerId)?.dispose("Handshake failed");
    this.receivers.get(peerId)?.dispose("Handshake failed");
    this.senders.delete(peerId);
    this.receivers.delete(peerId);
    this.log("error", `handshake-failed:${reason}`, peerId);
    this.updateState(peerId, peer);
  }

  private async flushCandidates(
    peerId: string,
    peer: PeerRecord,
  ): Promise<void> {
    const queued = peer.pendingCandidates.splice(0);
    for (const candidate of queued) {
      if (peer.disposed) return;
      await peer.connection.addIceCandidate(candidate);
    }
    if (queued.length > 0) this.log("info", "ice-queue-flushed", peerId);
  }

  private async restartIce(peerId: string, peer: PeerRecord): Promise<void> {
    if (peer.disposed) return;
    if (peer.restartAttempted) {
      peer.failed = true;
      this.updateState(peerId, peer);
      this.log("error", "ice-restart-exhausted", peerId);
      return;
    }

    peer.restartAttempted = true;
    try {
      const offer = await peer.connection.createOffer({ iceRestart: true });
      if (peer.disposed) return;
      await peer.connection.setLocalDescription(offer);
      if (peer.disposed) return;
      const sdp = peer.connection.localDescription?.sdp;
      if (!sdp) throw new Error("Restart offer did not include SDP");
      this.sendSignal(peerId, { kind: "offer", sdp });
      this.log("info", "ice-restart-offer-sent", peerId);
      peer.restartTimer = setTimeout(() => {
        if (
          peer.disposed ||
          peer.connection.iceConnectionState === "connected" ||
          peer.connection.iceConnectionState === "completed"
        ) {
          return;
        }
        peer.failed = true;
        this.log("error", "ice-restart-exhausted", peerId);
        this.updateState(peerId, peer);
      }, 10_000);
    } catch {
      if (peer.disposed) return;
      peer.failed = true;
      this.log("error", "ice-restart-failed", peerId);
    }
    this.updateState(peerId, peer);
  }

  private isRestartOwner(peerId: string): boolean {
    return this.localPeerId.localeCompare(peerId) < 0;
  }

  private async refreshCandidateType(
    peerId: string,
    peer: PeerRecord,
  ): Promise<void> {
    if (peer.disposed) return;
    try {
      const stats = await peer.connection.getStats();
      if (peer.disposed) return;
      let selectedPairId: string | undefined;
      stats.forEach((report) => {
        if (
          report.type === "transport" &&
          "selectedCandidatePairId" in report &&
          typeof report.selectedCandidatePairId === "string"
        ) {
          selectedPairId = report.selectedCandidatePairId;
        }
      });

      let pair = selectedPairId ? stats.get(selectedPairId) : undefined;
      if (!pair || pair.type !== "candidate-pair") {
        pair = undefined;
        stats.forEach((report) => {
          if (
            report.type === "candidate-pair" &&
            "state" in report &&
            report.state === "succeeded" &&
            "nominated" in report &&
            report.nominated
          ) {
            pair = report;
          }
        });
      }

      if (
        !pair ||
        !("localCandidateId" in pair) ||
        !("remoteCandidateId" in pair)
      ) {
        peer.candidateType = null;
      } else {
        const localType = this.readCandidateType(
          stats.get(pair.localCandidateId),
        );
        const remoteType = this.readCandidateType(
          stats.get(pair.remoteCandidateId),
        );
        peer.candidateType =
          localType === "relay" || remoteType === "relay"
            ? "relay"
            : localType === "srflx" || remoteType === "srflx"
              ? "srflx"
              : localType === "host" || remoteType === "host"
                ? "host"
                : null;
      }
      this.updateState(peerId, peer);
    } catch {
      this.log("error", "stats-read-failed", peerId);
    }
  }

  private readCandidateType(
    report: RTCStats | undefined,
  ): CandidateType | null {
    if (!report || !("candidateType" in report)) return null;
    const candidateType = report.candidateType;
    if (candidateType === "host" || candidateType === "relay") {
      return candidateType;
    }
    if (candidateType === "srflx" || candidateType === "prflx") {
      return "srflx";
    }
    return null;
  }

  private updateState(peerId: string, peer: PeerRecord): void {
    if (peer.disposed) return;
    this.events.emit("state", {
      peerId,
      userId: peer.directory?.userId ?? null,
      displayName: peer.directory?.displayName ?? null,
      role: peer.directory?.role ?? null,
      connectionState: peer.connection.connectionState,
      iceConnectionState: peer.connection.iceConnectionState,
      dataChannelState: peer.channel?.readyState ?? "unavailable",
      candidateType: peer.candidateType,
      failed: peer.failed,
      handshakeState: peer.handshakeState,
      algorithm: peer.remoteAlgorithm,
      fingerprint: peer.remoteFingerprint,
      sameIdentity: peer.sameIdentity,
      verified:
        peer.remoteFingerprint !== null &&
        this.verifiedFingerprints.has(peer.remoteFingerprint),
      handshakeError: peer.handshakeError,
      workspaceState: peer.workspaceState,
      workspaceVerifiedVersion: peer.workspaceVerifiedVersion,
    });
  }

  private log(level: "info" | "error", event: string, peerId?: string): void {
    this.events.emit("log", {
      at: Date.now(),
      level,
      event,
      ...(peerId ? { peerId } : {}),
    });
  }

  private disposePeer(peer: PeerRecord): void {
    peer.disposed = true;
    clearInterval(peer.statsTimer);
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    if (peer.waitingTimer) clearTimeout(peer.waitingTimer);
    for (const removeListener of peer.removeChannelListeners.splice(0)) {
      removeListener();
    }
    for (const removeListener of peer.removeListeners.splice(0)) {
      removeListener();
    }
    peer.channel?.close();
    peer.connection.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readableError(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Secure peer handshake failed";
}
