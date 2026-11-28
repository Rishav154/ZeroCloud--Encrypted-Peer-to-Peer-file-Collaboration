import { base64ToBytes, bytesToBase64, compareBytes, deriveSessionKey, fileControlMessageSchema, fingerprintPublicKey, helloMessageSchema, nearbyControlEnvelopeSchema, nearbyControlPayloadSchema, open, openNearbyControl, NearbyReplayGuard, readyMessageSchema, readyPayloadSchema, seal, utf8, type FileControlMessage, type NearbyControlPayload, type NearbyPeer, type NearbySignalData } from "@zerocloud/shared";
import type { StoredIdentity } from "../identity/identityStore";
import { localToRemoteAad, remoteToLocalAad, type PeerCryptoContext } from "../transfer/cryptoContext";
import { FileSender } from "../transfer/FileSender";
import { FileReceiver } from "../transfer/FileReceiver";
import type { TransferSnapshot } from "../transfer/types";
import { TypedEventEmitter } from "../webrtc/TypedEventEmitter";
import { connectRequestDecision, nearbyClickAction, nearbyOfferDecision } from "./policy";
import { routePeerMessage } from "./router";
import { SecureNearbyChannel } from "./SecureNearbyChannel";

export type NearbyState = "discovered" | "connecting" | "handshaking" | "secure" | "incompatible" | "mismatch" | "failed";
export type NearbySnapshot = NearbyPeer & { state: NearbyState; error: string | null };
type RecordPeer = { peer: NearbyPeer; pc: RTCPeerConnection; channel: RTCDataChannel | null; secureChannel: SecureNearbyChannel | null; sender: FileSender | null; receiver: FileReceiver | null; receiveReplay: NearbyReplayGuard; state: NearbyState; context: PeerCryptoContext | null; localNonce: Uint8Array | null; sentHello: boolean; receivedHello: boolean; receivedReady: boolean; pendingReady: string | null; requestTimes: number[]; offerTimes: number[]; pendingOfferIds: Set<number>; timeout: ReturnType<typeof setTimeout> | null };
type Events = { peer: NearbySnapshot; dropped: { peerId: string; count: number }; offer: { peerId: string; transferId: number; alias: string; fingerprint: string; metadata: { name: string; size: number; mime: string; sha256: string; chunkSize: number; totalChunks: number } }; transfer: TransferSnapshot; invite: { peerId: string; payload: Extract<NearbyControlPayload, { type: "workspace-invite" }> }; inviteAck: { peerId: string; payload: Extract<NearbyControlPayload, { type: "invite-ack" }> } };

export class NearbyManager {
  readonly events = new TypedEventEmitter<Events>();
  private readonly peers = new Map<string, NearbyPeer>();
  private readonly active = new Map<string, RecordPeer>();
  private readonly blocked = new Set<string>();
  private readonly invitePayloads = new Map<string, Extract<NearbyControlPayload, { type: "workspace-invite" }>>();
  private enabled = false;
  constructor(private readonly identity: StoredIdentity, private readonly send: (message: { type: "nearby-signal"; to: string; data: unknown }) => boolean, private readonly iceServers: RTCIceServer[] = []) {}

  enable(peers: NearbyPeer[]): void { this.enabled = true; this.updateDirectory(peers); }
  disable(): void { this.enabled = false; for (const record of this.active.values()) this.dispose(record); this.active.clear(); this.peers.clear(); }
  updateDirectory(peers: NearbyPeer[]): void {
    const incoming = new Set(peers.map((peer) => peer.peerId));
    for (const [id, record] of this.active) if (!incoming.has(id)) { this.dispose(record); this.active.delete(id); }
    this.peers.clear();
    for (const peer of peers) { this.peers.set(peer.peerId, peer); if (!this.active.has(peer.peerId)) this.emit(peer, "discovered", null); }
  }
  remove(peerId: string): void { this.peers.delete(peerId); const record = this.active.get(peerId); if (record) { this.dispose(record); this.active.delete(peerId); } }
  block(fingerprint: string): void { this.blocked.add(fingerprint); for (const record of this.active.values()) if (record.peer.fingerprint === fingerprint) { for (const transferId of record.pendingOfferIds) record.receiver?.decline(transferId, "Blocked by this device"); record.pendingOfferIds.clear(); record.sender?.cancelAll("Blocked by this device"); } }
  setBlockedFingerprints(fingerprints: Iterable<string>): void { this.blocked.clear(); for (const fingerprint of fingerprints) this.blocked.add(fingerprint); }
  getBlockedFingerprints(): string[] { return [...this.blocked]; }
  unblock(fingerprint: string): void { this.blocked.delete(fingerprint); }
  acceptOffer(peerId: string, transferId: number): void { const record = this.active.get(peerId); if (!record) return; record.pendingOfferIds.delete(transferId); record.receiver?.accept(transferId); }
  declineOffer(peerId: string, transferId: number, block = false): void { const record = this.active.get(peerId); if (!record) return; record.pendingOfferIds.delete(transferId); record.receiver?.decline(transferId); if (block) this.block(record.peer.fingerprint); }
  cancelFile(peerId: string, transferId: number): void { const record = this.active.get(peerId); record?.sender?.cancel(transferId); record?.receiver?.cancel(transferId); }
  sendFile(peerId: string, file: File): boolean { const record = this.active.get(peerId); if (this.blocked.has(record?.peer.fingerprint ?? "") || record?.state !== "secure" || !record.sender) return false; record.sender.enqueue(file, this.newTransferId()); return true; }
  sendControl(peerId: string, payload: NearbyControlPayload): boolean { const record = this.active.get(peerId); if (this.blocked.has(record?.peer.fingerprint ?? "") || record?.state !== "secure" || !record.secureChannel) return false; record.secureChannel.sendNearbyControl(payload); return true; }
  takeInvite(inviteId: string): Extract<NearbyControlPayload, { type: "workspace-invite" }> | null { const payload = this.invitePayloads.get(inviteId) ?? null; this.invitePayloads.delete(inviteId); return payload; }
  debugInject(peerId: string, type: "sync" | "manifest"): void { const channel = this.active.get(peerId)?.channel; if (channel?.readyState === "open") channel.send(JSON.stringify({ type })); }
  connect(peerId: string): void {
    if (!this.enabled) return;
    const peer = this.peers.get(peerId); if (!peer || this.blocked.has(peer.fingerprint)) return;
    const previous = this.active.get(peerId);
    if (previous && previous.state !== "failed" && previous.state !== "incompatible" && previous.state !== "mismatch") return;
    if (previous) { this.dispose(previous); this.active.delete(peerId); }
    if (this.active.size >= 8) { this.emit(peer, "failed", "Maximum of 8 nearby connections reached"); return; }
    const action = nearbyClickAction(this.localPeerId, peerId, false);
    if (action === "offer") void this.createOffer(peer);
    else if (action === "connect-request") { this.createRecord(peer); this.send({ type: "nearby-signal", to: peerId, data: { kind: "connect-request" } }); this.armOfferTimeout(peer); }
  }
  async handleSignal(from: string, data: NearbySignalData): Promise<void> {
    const peer = this.peers.get(from); if (!peer || !this.enabled) return;
    if (data.kind === "connect-request") {
      const now = Date.now(); let record = this.active.get(from);
      const times = (record?.requestTimes ?? []).filter((time) => now - time < 60_000);
      const decision = connectRequestDecision({ enabled: this.enabled, listed: this.peers.has(from), localPeerId: this.localPeerId, remotePeerId: from, blocked: this.blocked.has(peer.fingerprint), connections: this.active.size, requestsInLastMinute: times.length, attemptInProgress: false });
      if (decision === "blocked" || decision === "ignore") return;
      if (decision === "rate-limited") { this.events.emit("dropped", { peerId: from, count: 1 }); return; }
      if (record && record.state !== "failed") { record.requestTimes = [...times, now]; return; }
      if (record) { this.dispose(record); this.active.delete(from); record = undefined; }
      if (decision === "connection-limit") { this.events.emit("dropped", { peerId: from, count: 1 }); return; }
      await this.createOffer(peer, [...times, now]); return;
    }
    let record = this.active.get(from);
    if (!record && data.kind === "offer" && this.localPeerId > from) record = this.createRecord(peer);
    if (!record) return;
    try {
      if (data.kind === "offer" && data.sdp && this.localPeerId > from) {
        if (record.timeout) { clearTimeout(record.timeout); record.timeout = null; }
        await record.pc.setRemoteDescription({ type: "offer", sdp: data.sdp });
        const answer = await record.pc.createAnswer(); await record.pc.setLocalDescription(answer);
        if (answer.sdp) this.send({ type: "nearby-signal", to: from, data: { kind: "answer", sdp: answer.sdp } });
      } else if (data.kind === "answer" && data.sdp && this.localPeerId < from) await record.pc.setRemoteDescription({ type: "answer", sdp: data.sdp });
      else if (data.kind === "ice") await record.pc.addIceCandidate({ candidate: data.candidate.candidate, ...(data.candidate.sdpMid === undefined ? {} : { sdpMid: data.candidate.sdpMid }), ...(data.candidate.sdpMLineIndex === undefined ? {} : { sdpMLineIndex: data.candidate.sdpMLineIndex }), ...(data.candidate.usernameFragment === undefined ? {} : { usernameFragment: data.candidate.usernameFragment }) });
    } catch { this.fail(record, "Signaling failed"); }
  }
  get localPeerId(): string { return this.localId; }
  set localPeerId(value: string) { this.localId = value; }
  private localId = "";
  private createRecord(peer: NearbyPeer): RecordPeer {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const record: RecordPeer = { peer, pc, channel: null, secureChannel: null, sender: null, receiver: null, receiveReplay: new NearbyReplayGuard(), state: "connecting", context: null, localNonce: null, sentHello: false, receivedHello: false, receivedReady: false, pendingReady: null, requestTimes: [], offerTimes: [], pendingOfferIds: new Set(), timeout: null };
    this.active.set(peer.peerId, record); this.emit(peer, "connecting", null);
    pc.onicecandidate = (event) => { if (event.candidate) this.send({ type: "nearby-signal", to: peer.peerId, data: { kind: "ice", candidate: event.candidate.toJSON() } }); };
    pc.ondatachannel = (event) => { if (event.channel.label === "zc-nearby") this.attachChannel(record, event.channel); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === "failed" || pc.connectionState === "closed") this.fail(record, "Connection failed"); };
    return record;
  }
  private async createOffer(peer: NearbyPeer, requestTimes: number[] = []): Promise<void> {
    const record = this.createRecord(peer); record.requestTimes = requestTimes;
    record.channel = record.pc.createDataChannel("zc-nearby"); this.attachChannel(record, record.channel);
    try { const offer = await record.pc.createOffer(); await record.pc.setLocalDescription(offer); if (offer.sdp) this.send({ type: "nearby-signal", to: peer.peerId, data: { kind: "offer", sdp: offer.sdp } }); }
    catch { this.fail(record, "Could not create offer"); }
  }
  private attachChannel(record: RecordPeer, channel: RTCDataChannel): void {
    record.channel = channel; channel.binaryType = "arraybuffer"; channel.onopen = () => { void this.startHello(record); };
    channel.onmessage = (event) => { if (typeof event.data === "string") void this.handleData(record, event.data); else if (event.data instanceof ArrayBuffer) void record.receiver?.handleBinary(event.data); };
    channel.onclose = () => this.fail(record, "Data channel closed");
  }
  private async startHello(record: RecordPeer): Promise<void> {
    if (record.sentHello || !record.channel || record.channel.readyState !== "open") return;
    record.localNonce = crypto.getRandomValues(new Uint8Array(32)); record.sentHello = true; record.state = "handshaking"; this.emit(record.peer, "handshaking", null);
    record.channel.send(JSON.stringify({ type: "hello", v: 1, alg: this.identity.algorithm, publicKey: bytesToBase64(this.identity.publicKeyRaw), nonce: bytesToBase64(record.localNonce) }));
  }
  private async handleData(record: RecordPeer, raw: string): Promise<void> {
    let decoded: unknown; try { decoded = JSON.parse(raw) as unknown; } catch { return; }
    const routed = routePeerMessage("zc-nearby", decoded, () => this.events.emit("dropped", { peerId: record.peer.peerId, count: 1 }));
    if (!routed.accepted) return;
    if (decoded && typeof decoded === "object" && "type" in decoded && decoded.type === "hello") {
      const parsed = helloMessageSchema.safeParse(decoded); if (!parsed.success || record.receivedHello) return this.fail(record, "Invalid hello");
      record.receivedHello = true; if (!record.sentHello) await this.startHello(record);
      const hello = parsed.data; if (hello.alg !== this.identity.algorithm) { record.state = "incompatible"; this.emit(record.peer, "incompatible", "Incompatible identity algorithm"); return; }
      try {
        const remoteNonce = base64ToBytes(hello.nonce), remotePublicKey = base64ToBytes(hello.publicKey);
        if (!record.localNonce || remoteNonce.length !== 32 || compareBytes(record.localNonce, remoteNonce) === 0) throw new Error("Invalid hello nonce");
        const fingerprint = await fingerprintPublicKey(remotePublicKey);
        if (fingerprint !== record.peer.fingerprint) { record.state = "mismatch"; this.emit(record.peer, "mismatch", "Identity mismatch"); return; }
        const sessionKey = await deriveSessionKey({ algorithm: hello.alg, privateKey: this.identity.privateKey, localPublicKey: this.identity.publicKeyRaw, remotePublicKey, localNonce: record.localNonce, remoteNonce });
        record.context = { sessionKey, localFingerprint: this.identity.fingerprint, remoteFingerprint: fingerprint, localNonce: record.localNonce, remoteNonce };
        const sealed = await seal(sessionKey, utf8(JSON.stringify({ type: "ready", v: 1 })), localToRemoteAad(record.context, "ready"));
        record.channel?.send(JSON.stringify({ type: "ready", sealed: bytesToBase64(sealed) }));
        if (record.pendingReady) { const pendingReady = record.pendingReady; record.pendingReady = null; await this.confirmReady(record, pendingReady); }
      } catch { this.fail(record, "Handshake failed"); }
      return;
    }
    if (decoded && typeof decoded === "object" && "type" in decoded && decoded.type === "ready") {
      const parsed = readyMessageSchema.safeParse(decoded); if (!parsed.success) return this.fail(record, "Invalid ready");
      if (record.receivedReady || record.pendingReady) return;
      if (!record.context) { record.pendingReady = parsed.data.sealed; return; }
      await this.confirmReady(record, parsed.data.sealed);
      return;
    }
    if (routed.type === "nearby-control") { await this.handleNearbyControl(record, decoded); return; }
  }

  private async confirmReady(record: RecordPeer, sealed: string): Promise<void> {
    const context = record.context;
    if (!context || record.receivedReady) return;
    record.receivedReady = true;
    try {
      const opened = await open(context.sessionKey, base64ToBytes(sealed), remoteToLocalAad(context, "ready"));
      const payload: unknown = JSON.parse(new TextDecoder().decode(opened));
      if (!readyPayloadSchema.safeParse(payload).success) throw new Error();
      record.state = "secure";
      if (record.timeout) clearTimeout(record.timeout);
      this.setupTransfers(record);
      this.emit(record.peer, "secure", null);
    } catch { this.fail(record, "Handshake confirmation failed"); }
  }

  private setupTransfers(record: RecordPeer): void {
    const context = record.context;
    const channel = record.channel;
    if (!context || !channel || record.secureChannel) return;
    const secureChannel = new SecureNearbyChannel(channel, context.sessionKey, context.localFingerprint, context.remoteFingerprint, () => this.events.emit("dropped", { peerId: record.peer.peerId, count: 1 }));
    record.secureChannel = secureChannel;
    record.sender = new FileSender(record.peer.peerId, secureChannel.asDataChannel(), context);
    record.receiver = new FileReceiver(record.peer.peerId, secureChannel.asDataChannel(), context, () => "editor");
    record.sender.events.on("transfer", (transfer) => this.events.emit("transfer", transfer));
    record.receiver.events.on("transfer", (transfer) => {
      if (transfer.state !== "waiting") record.pendingOfferIds.delete(transfer.transferId);
      this.events.emit("transfer", transfer);
    });
    record.receiver.events.on("offer", (offer) => {
      const metadata = { ...offer.metadata, sha256: offer.metadata.sha256 };
      this.events.emit("offer", { peerId: offer.peerId, transferId: offer.transferId, alias: record.peer.alias, fingerprint: record.peer.fingerprint, metadata });
    });
  }

  private async handleNearbyControl(record: RecordPeer, value: unknown): Promise<void> {
    const context = record.context;
    if (record.state !== "secure" || !context || !record.secureChannel) return;
    const parsedEnvelope = nearbyControlEnvelopeSchema.safeParse(value);
    if (!parsedEnvelope.success) { this.events.emit("dropped", { peerId: record.peer.peerId, count: 1 }); return; }
    let payload: NearbyControlPayload;
    try {
      payload = await openNearbyControl(context.sessionKey, parsedEnvelope.data, context.remoteFingerprint, context.localFingerprint, record.receiveReplay, nearbyControlPayloadSchema);
    } catch { this.events.emit("dropped", { peerId: record.peer.peerId, count: 1 }); return; }
    if (this.blocked.has(record.peer.fingerprint) && payload.type !== "nearby-file-offer") { this.events.emit("dropped", { peerId: record.peer.peerId, count: 1 }); return; }
    if (payload.type === "workspace-invite") {
      this.invitePayloads.set(payload.inviteId, payload);
      this.events.emit("invite", { peerId: record.peer.peerId, payload });
      return;
    }
    if (payload.type === "invite-ack") { this.events.emit("inviteAck", { peerId: record.peer.peerId, payload }); return; }
    if (payload.type === "nearby-file-offer") {
      const now = Date.now();
      record.offerTimes = record.offerTimes.filter((time) => now - time < 60_000);
      const decision = nearbyOfferDecision({ blocked: this.blocked.has(record.peer.fingerprint), offersInLastMinute: record.offerTimes.length, pendingOffers: record.pendingOfferIds.size });
      record.offerTimes.push(now);
      if (decision !== "accept") {
        const reason = decision === "blocked" ? "Blocked fingerprint" : "Nearby offer limit reached";
        record.secureChannel.sendNearbyControl({ type: "nearby-file-reject", transferId: payload.transferId, reason });
        this.events.emit("dropped", { peerId: record.peer.peerId, count: 1 });
        return;
      }
      record.pendingOfferIds.add(payload.transferId);
    }
    const control = toFileControl(payload);
    if (!control) return;
    if (control.type === "file-accept" || control.type === "file-reject" || control.type === "file-ack" || control.type === "file-cancel") record.sender?.handleControl(control);
    if (control.type === "file-offer" || control.type === "file-complete" || control.type === "file-cancel") await record.receiver?.handleString(JSON.stringify(control));
  }

  private newTransferId(): number {
    const id = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
    return id === 0 ? 1 : id;
  }
  private armOfferTimeout(peer: NearbyPeer): void { const record = this.active.get(peer.peerId); if (!record) return; record.timeout = setTimeout(() => { if (record.state === "connecting") this.fail(record, "No offer received; retry"); }, 10_000); }
  private fail(record: RecordPeer, error: string): void { if (record.timeout) clearTimeout(record.timeout); record.state = "failed"; this.emit(record.peer, "failed", error); }
  private dispose(record: RecordPeer): void { if (record.timeout) clearTimeout(record.timeout); record.sender?.dispose(); record.receiver?.dispose(); record.pc.onicecandidate = null; record.pc.ondatachannel = null; record.pc.close(); }
  private emit(peer: NearbyPeer, state: NearbyState, error: string | null): void { this.events.emit("peer", { ...peer, state, error }); }
}

function toFileControl(payload: NearbyControlPayload): FileControlMessage | null {
  if (payload.type === "workspace-invite" || payload.type === "invite-ack") return null;
  const fileType = payload.type.replace("nearby-file-", "file-");
  const value: unknown = { ...payload, type: fileType };
  const parsed = fileControlMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
