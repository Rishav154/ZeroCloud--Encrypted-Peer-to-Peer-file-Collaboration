import {
  AesGcmChunkTransform,
  FILE_CHUNK_SIZE,
  MAX_FILE_SIZE,
  base64ToBytes,
  chunkCount,
  fileControlMessageSchema,
  fileOfferPayloadSchema,
  open,
  type ChunkTransform,
  type FileControlMessage,
  type FileOfferMessage,
  type FileOfferPayload,
  type WorkspaceRole,
  unpackChunk,
} from "@zerocloud/shared";
import { TypedEventEmitter } from "../webrtc/TypedEventEmitter";
import { remoteToLocalAad, type PeerCryptoContext } from "./cryptoContext";
import type { IncomingOffer, TransferSnapshot } from "./types";

type ReceiverEvents = {
  transfer: TransferSnapshot;
  offer: IncomingOffer;
  log: { peerId: string; event: string; error?: boolean };
};
type Incoming = {
  transferId: number;
  metadata: FileOfferPayload;
  fileKey: CryptoKey;
  transform: ChunkTransform;
  parts: Uint8Array[];
  nextIndex: number;
  bytes: number;
  accepted: boolean;
  snapshot: TransferSnapshot;
  sampleTime: number;
  sampleBytes: number;
};

export class FileReceiver {
  readonly events = new TypedEventEmitter<ReceiverEvents>();
  private readonly incoming = new Map<number, Incoming>();
  private disposed = false;
  private chunkQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly peerId: string,
    private readonly channel: RTCDataChannel,
    private readonly cryptoContext: PeerCryptoContext,
    private readonly getSenderRole: () => WorkspaceRole | null = () => null,
  ) {}

  async handleString(raw: string): Promise<boolean> {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw) as unknown;
    } catch {
      return false;
    }
    const parsed = fileControlMessageSchema.safeParse(decoded);
    if (!parsed.success) return false;
    await this.handleControl(parsed.data);
    return true;
  }

  handleBinary(buffer: ArrayBuffer): Promise<void> {
    this.chunkQueue = this.chunkQueue
      .then(() => this.processBinary(buffer))
      .catch(() => undefined);
    return this.chunkQueue;
  }

  private async processBinary(buffer: ArrayBuffer): Promise<void> {
    let packed: ReturnType<typeof unpackChunk>;
    try {
      packed = unpackChunk(buffer);
    } catch {
      this.log("invalid-chunk", true);
      return;
    }
    const item = this.incoming.get(packed.transferId);
    if (!item?.accepted) return;
    if (packed.index !== item.nextIndex) return this.integrityFailure(item);
    const expectedPlainLength = Math.min(
      item.metadata.chunkSize,
      item.metadata.size - packed.index * item.metadata.chunkSize,
    );
    if (
      expectedPlainLength < 0 ||
      packed.payload.byteLength !== expectedPlainLength + 16
    ) {
      return this.integrityFailure(item);
    }
    try {
      const decoded = await item.transform.decode(packed.payload, {
        transferId: item.transferId,
        index: packed.index,
      });
      if (this.disposed || this.incoming.get(item.transferId) !== item) return;
      if (decoded.byteLength !== expectedPlainLength) {
        return this.integrityFailure(item);
      }
      item.bytes += decoded.byteLength;
      if (item.bytes > item.metadata.size) {
        return this.integrityFailure(item);
      }
      item.parts.push(decoded.slice());
      item.nextIndex += 1;
      item.snapshot.progress = item.metadata.size
        ? item.bytes / item.metadata.size
        : 1;
      const now = performance.now();
      if (now - item.sampleTime >= 1000) {
        item.snapshot.speed =
          ((item.bytes - item.sampleBytes) / (now - item.sampleTime)) * 1000;
        item.snapshot.eta = item.snapshot.speed
          ? Math.ceil((item.metadata.size - item.bytes) / item.snapshot.speed)
          : null;
        item.sampleTime = now;
        item.sampleBytes = item.bytes;
      }
      this.emit(item);
    } catch {
      if (!this.disposed && this.incoming.get(item.transferId) === item) {
        this.integrityFailure(item);
      }
    }
  }

  accept(transferId: number): void {
    const item = this.incoming.get(transferId);
    if (!item || item.accepted || this.disposed) return;
    item.accepted = true;
    item.snapshot.state = "receiving";
    this.emit(item);
    this.send({ type: "file-accept", transferId });
  }

  decline(transferId: number, reason = "Declined by receiver"): void {
    const item = this.incoming.get(transferId);
    if (!item) return;
    this.send({ type: "file-reject", transferId, reason });
    item.parts = [];
    item.snapshot.state = "rejected";
    item.snapshot.error = reason;
    this.emit(item);
    this.incoming.delete(transferId);
  }

  cancel(transferId: number, reason = "Cancelled by receiver"): void {
    const item = this.incoming.get(transferId);
    if (!item) return;
    this.send({ type: "file-cancel", transferId, reason });
    item.parts = [];
    item.snapshot.state = "cancelled";
    item.snapshot.error = reason;
    this.emit(item);
    this.incoming.delete(transferId);
  }

  dispose(reason = "Peer disconnected"): void {
    this.disposed = true;
    for (const item of this.incoming.values()) {
      item.parts = [];
      item.snapshot.state = "failed";
      item.snapshot.error = reason;
      this.emit(item);
    }
    this.incoming.clear();
    this.events.clear();
  }

  private async handleControl(message: FileControlMessage): Promise<void> {
    if (message.type === "file-offer") return this.handleOffer(message);
    const item = this.incoming.get(message.transferId);
    if (!item) return;
    if (message.type === "file-cancel") {
      item.parts = [];
      item.snapshot.state =
        message.reason === "integrity" ? "failed" : "cancelled";
      item.snapshot.error =
        message.reason === "integrity"
          ? "Integrity check failed"
          : (message.reason ?? "Cancelled by sender");
      this.emit(item);
      this.incoming.delete(message.transferId);
      return;
    }
    if (message.type !== "file-complete") return;
    await this.chunkQueue;
    if (!item.accepted) return this.integrityFailure(item);
    if (
      item.nextIndex !== item.metadata.totalChunks ||
      item.bytes !== item.metadata.size
    ) {
      return this.integrityFailure(item);
    }
    item.snapshot.state = "verifying";
    this.emit(item);
    try {
      const blob = new Blob(
        item.parts.map((part) => part.buffer as ArrayBuffer),
        {
          type: item.metadata.mime || "application/octet-stream",
        },
      );
      const digest = await crypto.subtle.digest(
        "SHA-256",
        await blob.arrayBuffer(),
      );
      const actual = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      if (actual.toLowerCase() !== item.metadata.sha256.toLowerCase()) {
        this.send({
          type: "file-ack",
          transferId: message.transferId,
          ok: false,
          reason: "Integrity check failed",
        });
        return this.fail(item, "Integrity check failed", false);
      }
      item.parts = [];
      item.snapshot.state = "done";
      item.snapshot.progress = 1;
      item.snapshot.blob = blob;
      this.send({ type: "file-ack", transferId: message.transferId, ok: true });
      this.emit(item);
      this.incoming.delete(message.transferId);
    } catch {
      this.send({
        type: "file-ack",
        transferId: message.transferId,
        ok: false,
        reason: "Integrity check failed",
      });
      this.fail(item, "Integrity check failed", false);
    }
  }

  private async handleOffer(wireOffer: FileOfferMessage): Promise<void> {
    if (this.disposed) return;
    const transferId = wireOffer.transferId;
    if (this.getSenderRole() !== "editor" && this.getSenderRole() !== "owner") {
      this.rejectMetadata(transferId, "no write permission");
      return;
    }
    try {
      const sealed = base64ToBytes(wireOffer.sealed);
      const plaintext = await open(
        this.cryptoContext.sessionKey,
        sealed,
        remoteToLocalAad(this.cryptoContext, "file-offer", transferId),
      );
      if (this.disposed) return;
      const parsedJson: unknown = JSON.parse(
        new TextDecoder().decode(plaintext),
      );
      const parsed = fileOfferPayloadSchema.safeParse(parsedJson);
      if (!parsed.success) throw new Error("Invalid encrypted file metadata");
      const metadata = parsed.data;
      const rawKey = base64ToBytes(metadata.fileKey);
      if (rawKey.byteLength !== 32)
        throw new Error("Invalid encrypted file key");
      if (metadata.size > MAX_FILE_SIZE)
        return this.rejectMetadata(transferId, "Maximum file size is 500 MB");
      if (
        metadata.chunkSize !== FILE_CHUNK_SIZE ||
        metadata.totalChunks !== chunkCount(metadata.size, metadata.chunkSize)
      ) {
        return this.rejectMetadata(
          transferId,
          "Invalid encrypted file metadata",
        );
      }
      if (this.incoming.has(transferId))
        return this.rejectMetadata(transferId, "Transfer ID is already active");
      const fileKey = await crypto.subtle.importKey(
        "raw",
        rawKey.slice().buffer as ArrayBuffer,
        { name: "AES-GCM" },
        false,
        ["decrypt"],
      );
      rawKey.fill(0);
      const transform = new AesGcmChunkTransform(
        fileKey,
        metadata.totalChunks,
        transferId,
      );
      const snapshot: TransferSnapshot = {
        key: `${this.peerId}:${transferId}`,
        transferId,
        peerId: this.peerId,
        direction: "incoming",
        name: metadata.name,
        size: metadata.size,
        state: "waiting",
        progress: 0,
        speed: 0,
        eta: null,
      };
      const item: Incoming = {
        transferId,
        metadata,
        fileKey,
        transform,
        parts: [],
        nextIndex: 0,
        bytes: 0,
        accepted: false,
        snapshot,
        sampleTime: performance.now(),
        sampleBytes: 0,
      };
      this.incoming.set(transferId, item);
      const displayMetadata = {
        name: metadata.name,
        size: metadata.size,
        mime: metadata.mime,
        chunkSize: metadata.chunkSize,
        totalChunks: metadata.totalChunks,
        sha256: metadata.sha256,
      };
      this.events.emit("offer", {
        peerId: this.peerId,
        transferId,
        metadata: displayMetadata,
      });
      this.emit(item);
    } catch {
      this.failEncryptedOffer(transferId);
    }
  }

  private rejectMetadata(transferId: number, reason: string): void {
    this.send({ type: "file-reject", transferId, reason });
    this.events.emit("transfer", {
      key: `${this.peerId}:${transferId}`,
      transferId,
      peerId: this.peerId,
      direction: "incoming",
      name: "Encrypted file",
      size: 0,
      state: "rejected",
      progress: 0,
      speed: 0,
      eta: null,
      error: reason,
    });
  }

  private failEncryptedOffer(transferId: number): void {
    this.send({ type: "file-cancel", transferId, reason: "integrity" });
    this.events.emit("transfer", {
      key: `${this.peerId}:${transferId}`,
      transferId,
      peerId: this.peerId,
      direction: "incoming",
      name: "Encrypted file",
      size: 0,
      state: "failed",
      progress: 0,
      speed: 0,
      eta: null,
      error: "Integrity check failed",
    });
  }

  private integrityFailure(item: Incoming): void {
    this.fail(item, "Integrity check failed");
  }

  private fail(item: Incoming, reason: string, notifySender = true): void {
    item.parts = [];
    item.snapshot.state = "failed";
    item.snapshot.error = reason;
    if (notifySender)
      this.send({
        type: "file-cancel",
        transferId: item.transferId,
        reason: "integrity",
      });
    this.emit(item);
    this.incoming.delete(item.transferId);
  }

  private send(message: FileControlMessage): void {
    if (this.channel.readyState === "open")
      this.channel.send(JSON.stringify(message));
  }
  private emit(item: Incoming): void {
    this.events.emit("transfer", { ...item.snapshot });
  }
  private log(event: string, error = false): void {
    this.events.emit("log", {
      peerId: this.peerId,
      event,
      ...(error ? { error: true } : {}),
    });
  }
}
