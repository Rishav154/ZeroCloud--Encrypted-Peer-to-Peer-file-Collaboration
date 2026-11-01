import {
  concatBytes,
  compareBytes,
  toArrayBuffer,
  utf8,
  withLengthPrefix,
} from "./encoding.js";

export type AadContext = {
  context: string;
  senderFingerprint: string;
  receiverFingerprint: string;
  senderNonce: Uint8Array;
  receiverNonce: Uint8Array;
  transferId?: number;
};

export function buildAad(args: AadContext): Uint8Array {
  const { senderNonce, receiverNonce } = args;
  if (senderNonce.length !== 32 || receiverNonce.length !== 32) {
    throw new Error("AAD nonces must each be 32 bytes");
  }
  const nonceOrder = compareBytes(senderNonce, receiverNonce);
  if (nonceOrder === 0) throw new Error("Handshake nonces must be unique");
  const transferMarker = new Uint8Array(5);
  transferMarker[0] = args.transferId === undefined ? 0 : 1;
  if (args.transferId !== undefined) {
    if (
      !Number.isInteger(args.transferId) ||
      args.transferId < 0 ||
      args.transferId > 0xffffffff
    ) {
      throw new RangeError("Transfer ID must be a uint32 integer");
    }
    new DataView(transferMarker.buffer).setUint32(1, args.transferId, false);
  }
  const sortedNonces =
    nonceOrder < 0
      ? [senderNonce, receiverNonce]
      : [receiverNonce, senderNonce];
  const direction = new Uint8Array([nonceOrder < 0 ? 0 : 1]);
  return concatBytes(
    withLengthPrefix(utf8(args.context)),
    withLengthPrefix(utf8(args.senderFingerprint)),
    withLengthPrefix(utf8(args.receiverFingerprint)),
    transferMarker,
    ...sortedNonces.map(withLengthPrefix),
    direction,
  );
}

export async function seal(
  sessionKey: CryptoKey,
  plaintextBytes: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    sessionKey,
    toArrayBuffer(plaintextBytes),
  );
  return concatBytes(iv, new Uint8Array(ciphertext));
}

export async function open(
  sessionKey: CryptoKey,
  envelope: Uint8Array,
  aad: Uint8Array,
): Promise<Uint8Array> {
  if (envelope.length < 28) throw new Error("Sealed envelope is truncated");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(envelope.subarray(0, 12)),
      additionalData: toArrayBuffer(aad),
      tagLength: 128,
    },
    sessionKey,
    toArrayBuffer(envelope.subarray(12)),
  );
  return new Uint8Array(plaintext);
}
