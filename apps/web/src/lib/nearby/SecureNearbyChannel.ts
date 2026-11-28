import { nearbyControlPayloadSchema, sealNearbyControl, type NearbyControlPayload } from "@zerocloud/shared";

export class SecureNearbyChannel {
  private sendSequence = 0;
  private pendingBytes = 0;
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly raw: RTCDataChannel,
    private readonly sessionKey: CryptoKey,
    private readonly localFingerprint: string,
    private readonly remoteFingerprint: string,
    private readonly onError: () => void = () => {},
  ) {}

  get readyState(): RTCDataChannelState { return this.raw.readyState; }
  get bufferedAmount(): number { return this.raw.bufferedAmount + this.pendingBytes; }
  get bufferedAmountLowThreshold(): number { return this.raw.bufferedAmountLowThreshold; }
  set bufferedAmountLowThreshold(value: number) { this.raw.bufferedAmountLowThreshold = value; }

  send(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      this.sendQueue = this.sendQueue.then(() => {
        if (this.raw.readyState !== "open") return;
        this.raw.send(data);
      });
      return;
    }
    let decoded: unknown;
    try { decoded = JSON.parse(data) as unknown; } catch { this.onError(); return; }
    if (!decoded || typeof decoded !== "object" || !("type" in decoded) || typeof decoded.type !== "string") { this.onError(); return; }
    const nearbyType = decoded.type.startsWith("file-") ? `nearby-${decoded.type}` : decoded.type;
    const payload: unknown = { ...decoded, type: nearbyType };
    const parsed = nearbyControlPayloadSchema.safeParse(payload);
    if (!parsed.success) { this.onError(); return; }
    this.sendNearbyControl(parsed.data);
  }

  sendNearbyControl(payload: NearbyControlPayload): void {
    this.sendSequence += 1;
    const seq = this.sendSequence;
    const size = JSON.stringify(payload).length;
    this.pendingBytes += size;
    this.sendQueue = this.sendQueue.then(async () => {
      const envelope = await sealNearbyControl(this.sessionKey, {
        messageType: payload.type,
        senderFingerprint: this.localFingerprint,
        receiverFingerprint: this.remoteFingerprint,
        seq,
      }, payload);
      if (this.raw.readyState === "open") this.raw.send(JSON.stringify(envelope));
    }).catch(() => { this.onError(); }).finally(() => { this.pendingBytes = Math.max(0, this.pendingBytes - size); });
  }

  addEventListener(type: "bufferedamountlow" | "close", listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void {
    this.raw.addEventListener(type, listener, options);
  }

  removeEventListener(type: "bufferedamountlow" | "close", listener: EventListenerOrEventListenerObject): void {
    this.raw.removeEventListener(type, listener);
  }

  asDataChannel(): RTCDataChannel { return this as unknown as RTCDataChannel; }
}
