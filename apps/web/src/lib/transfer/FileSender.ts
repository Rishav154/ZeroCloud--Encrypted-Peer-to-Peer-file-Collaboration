import {
  AesGcmChunkTransform,
  FILE_CHUNK_SIZE,
  MAX_FILE_SIZE,
  bytesToBase64,
  chunkCount,
  packChunk,
  seal,
  utf8,
  type ChunkTransform,
  type FileControlMessage,
  type FileOfferMessage,
  type FileOfferPayload,
} from "@zerocloud/shared";
import { TypedEventEmitter } from "../webrtc/TypedEventEmitter";
import { localToRemoteAad, type PeerCryptoContext } from "./cryptoContext";
import type { TransferSnapshot } from "./types";

type SenderEvents = {
  transfer: TransferSnapshot;
  log: { peerId: string; event: string; error?: boolean };
};
type Pending = {
  resolve: (message: FileControlMessage | null) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Job = {
  file: File;
  transferId: number;
  snapshot: TransferSnapshot;
  cancelled: boolean;
  pending: Pending | null;
  wakeBuffer: (() => void) | null;
};

export class FileSender {
  readonly events = new TypedEventEmitter<SenderEvents>();
  private readonly queue: Job[] = [];
  private active: Job | null = null;
  private disposed = false;

  constructor(
    private readonly peerId: string,
    private readonly channel: RTCDataChannel,
    private readonly cryptoContext: PeerCryptoContext,
  ) {}

  enqueue(file: File, transferId: number): void {
    const job: Job = {
      file,
      transferId,
      snapshot: {
        key: `${this.peerId}:${transferId}`,
        transferId,
        peerId: this.peerId,
        direction: "outgoing",
        name: file.name,
        size: file.size,
        state: "preparing",
        progress: 0,
        speed: 0,
        eta: null,
      },
      cancelled: false,
      pending: null,
      wakeBuffer: null,
    };
    this.emit(job);
    if (this.disposed)
      return this.finish(job, "failed", "Peer connection is closed");
    if (file.size > MAX_FILE_SIZE)
      return this.finish(job, "failed", "Maximum file size is 500 MB");
    this.queue.push(job);
    void this.pump();
  }

  handleControl(message: FileControlMessage): void {
    const job =
      this.active?.transferId === message.transferId
        ? this.active
        : this.queue.find((entry) => entry.transferId === message.transferId);
    if (!job) return;
    if (message.type === "file-cancel") {
      job.cancelled = true;
      job.wakeBuffer?.();
      job.pending?.resolve(message);
      const integrityFailure = message.reason === "integrity";
      const state = integrityFailure ? "failed" : "cancelled";
      const reason = integrityFailure
        ? "Integrity check failed"
        : (message.reason ?? "Cancelled by peer");
      this.finish(job, state, reason);
      if (job !== this.active) this.queue.splice(this.queue.indexOf(job), 1);
      return;
    }
    if (
      message.type === "file-accept" ||
      message.type === "file-reject" ||
      message.type === "file-ack"
    ) {
      job.pending?.resolve(message);
    }
  }

  cancel(transferId: number, reason = "Cancelled by sender"): void {
    const job =
      this.active?.transferId === transferId
        ? this.active
        : this.queue.find((entry) => entry.transferId === transferId);
    if (!job) return;
    job.cancelled = true;
    job.wakeBuffer?.();
    try {
      this.send({ type: "file-cancel", transferId, reason });
    } catch {
      /* channel may already be closed */
    }
    job.pending?.resolve(null);
    this.finish(job, "cancelled", reason);
    if (job !== this.active) this.queue.splice(this.queue.indexOf(job), 1);
  }

  dispose(reason = "Peer disconnected"): void {
    this.disposed = true;
    if (this.active) {
      this.active.cancelled = true;
      this.active.wakeBuffer?.();
      this.active.pending?.resolve(null);
      this.finish(this.active, "failed", reason);
    }
    for (const job of this.queue.splice(0)) this.finish(job, "failed", reason);
    this.events.clear();
  }

  private async pump(): Promise<void> {
    if (this.active || this.disposed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.active = job;
    try {
      await this.run(job);
    } catch (error) {
      if (!job.cancelled)
        this.finish(job, "failed", readableCryptoError(error));
    } finally {
      this.active = null;
      void this.pump();
    }
  }

  private async run(job: Job): Promise<void> {
    const sha256 = await hashFile(job.file);
    if (job.cancelled || this.disposed) return;
    const totalChunks = chunkCount(job.file.size);
    const fileKey = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const rawFileKey = new Uint8Array(
      await crypto.subtle.exportKey("raw", fileKey),
    );
    const payload: FileOfferPayload = {
      name: job.file.name || "unnamed",
      size: job.file.size,
      mime: job.file.type,
      chunkSize: FILE_CHUNK_SIZE,
      totalChunks,
      sha256,
      fileKey: bytesToBase64(rawFileKey),
    };
    rawFileKey.fill(0);
    const sealed = await seal(
      this.cryptoContext.sessionKey,
      utf8(JSON.stringify(payload)),
      localToRemoteAad(this.cryptoContext, "file-offer", job.transferId),
    );
    const offer: FileOfferMessage = {
      type: "file-offer",
      transferId: job.transferId,
      sealed: bytesToBase64(sealed),
    };
    const transform: ChunkTransform = new AesGcmChunkTransform(
      fileKey,
      totalChunks,
      job.transferId,
    );

    this.setState(job, "waiting");
    this.send(offer);
    const response = await this.waitFor(job, 60_000);
    if (job.cancelled || this.disposed) return;
    if (!response && !job.cancelled) {
      this.send({
        type: "file-cancel",
        transferId: job.transferId,
        reason: "Offer timed out",
      });
      return this.finish(job, "failed", "Offer timed out after 60 seconds");
    }
    if (this.disposed) return;
    if (!response || response.type === "file-cancel")
      return this.finish(job, "cancelled", "Transfer cancelled");
    if (response.type === "file-reject")
      return this.finish(job, "rejected", response.reason);
    if (response.type !== "file-accept")
      throw new Error("Unexpected response to file offer");

    this.setState(job, "sending");
    let sentBytes = 0;
    let sampleTime = performance.now();
    let sampleBytes = 0;
    for (let index = 0; index < totalChunks; index += 1) {
      if (job.cancelled || this.disposed) return;
      const start = index * FILE_CHUNK_SIZE;
      const plain = new Uint8Array(
        await job.file
          .slice(start, Math.min(start + FILE_CHUNK_SIZE, job.file.size))
          .arrayBuffer(),
      );
      let encoded = await transform.encode(plain, {
        transferId: job.transferId,
        index,
      });
      if (
        process.env.NODE_ENV === "development" &&
        process.env.NEXT_PUBLIC_DEBUG_TAMPER === "true" &&
        index === 2
      ) {
        encoded = encoded.slice();
        encoded[0] = encoded[0]! ^ 1;
        this.log("debug-tamper:chunk-3");
      }
      if (process.env.NEXT_PUBLIC_DEBUG_WIRE === "true" && index < 3) {
        this.log(
          `wire-chunk:${job.transferId}:${index}:bytes=${encoded.length}:prefix=${hexPrefix(encoded)}`,
        );
      }
      await this.waitForBuffer(job);
      if (job.cancelled || this.disposed) return;
      this.channel.send(packChunk(job.transferId, index, encoded));
      sentBytes += plain.byteLength;
      job.snapshot.progress = job.file.size ? sentBytes / job.file.size : 1;
      const now = performance.now();
      if (now - sampleTime >= 1000) {
        job.snapshot.speed =
          ((sentBytes - sampleBytes) / (now - sampleTime)) * 1000;
        job.snapshot.eta = job.snapshot.speed
          ? Math.ceil((job.file.size - sentBytes) / job.snapshot.speed)
          : null;
        sampleTime = now;
        sampleBytes = sentBytes;
      }
      this.emit(job);
    }
    job.snapshot.progress = 1;
    this.emit(job);
    this.send({ type: "file-complete", transferId: job.transferId });
    this.setState(job, "verifying");
    const ack = await this.waitFor(job, 60_000);
    if (!ack || ack.type !== "file-ack")
      throw new Error("No verification acknowledgement received");
    if (!ack.ok)
      throw new Error(ack.reason ?? "Receiver could not verify the file");
    this.finish(job, "done");
  }

  private waitFor(
    job: Job,
    timeout: number,
  ): Promise<FileControlMessage | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        job.pending = null;
        resolve(null);
      }, timeout);
      job.pending = {
        resolve: (message) => {
          clearTimeout(timer);
          job.pending = null;
          resolve(message);
        },
        timer,
      };
    });
  }

  private async waitForBuffer(job: Job): Promise<void> {
    if (this.channel.readyState !== "open")
      throw new Error("DataChannel closed during transfer");
    this.channel.bufferedAmountLowThreshold = 256 * 1024;
    if (this.channel.bufferedAmount <= 1024 * 1024) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        this.channel.removeEventListener("bufferedamountlow", onLow);
        this.channel.removeEventListener("close", onClose);
      };
      const onLow = (): void => {
        cleanup();
        job.wakeBuffer = null;
        resolve();
      };
      const onClose = (): void => {
        cleanup();
        job.wakeBuffer = null;
        reject(new Error("DataChannel closed during transfer"));
      };
      const timer = setTimeout(() => {
        cleanup();
        job.wakeBuffer = null;
        reject(new Error("Timed out waiting for DataChannel backpressure"));
      }, 30_000);
      this.channel.addEventListener("bufferedamountlow", onLow, { once: true });
      this.channel.addEventListener("close", onClose, { once: true });
      job.wakeBuffer = onLow;
      if (
        job.cancelled ||
        this.channel.bufferedAmount <= this.channel.bufferedAmountLowThreshold
      ) {
        cleanup();
        job.wakeBuffer = null;
        resolve();
      }
    });
    if (this.channel.readyState !== "open")
      throw new Error("DataChannel closed during transfer");
  }

  private send(message: FileControlMessage): void {
    if (this.channel.readyState !== "open")
      throw new Error("DataChannel is not open");
    const wire = JSON.stringify(message);
    this.channel.send(wire);
    if (process.env.NEXT_PUBLIC_DEBUG_WIRE === "true") {
      if (message.type === "file-offer") {
        const sealedBytes = new Uint8Array(atob(message.sealed).length);
        const decoded = atob(message.sealed);
        for (let index = 0; index < decoded.length; index += 1)
          sealedBytes[index] = decoded.charCodeAt(index);
        this.log(
          `wire-control:file-offer:sealed-bytes=${sealedBytes.length}:prefix=${hexPrefix(sealedBytes)}`,
        );
      } else {
        this.log(`wire-control:${message.type}:bytes=${utf8(wire).length}`);
      }
    }
  }

  private setState(job: Job, state: TransferSnapshot["state"]): void {
    job.snapshot.state = state;
    this.emit(job);
  }
  private finish(
    job: Job,
    state: TransferSnapshot["state"],
    error?: string,
  ): void {
    job.snapshot.state = state;
    if (error) job.snapshot.error = error;
    job.snapshot.eta = null;
    this.emit(job);
  }
  private emit(job: Job): void {
    this.events.emit("transfer", { ...job.snapshot });
  }
  private log(event: string): void {
    this.events.emit("log", { peerId: this.peerId, event });
  }
}

function hexPrefix(bytes: Uint8Array): string {
  return Array.from(bytes.subarray(0, 16), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function readableCryptoError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "File encryption failed";
}

async function hashFile(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
