import type { IdentityAlgorithm } from "../index.js";
import {
  concatBytes,
  compareBytes,
  toArrayBuffer,
  utf8,
  withLengthPrefix,
} from "./encoding.js";

const SESSION_INFO = utf8("zerocloud/v1/session");
const SALT_PREFIX = utf8("zerocloud/v1/salt");

export async function deriveSessionKey(args: {
  algorithm: IdentityAlgorithm;
  privateKey: CryptoKey;
  localPublicKey: Uint8Array;
  remotePublicKey: Uint8Array;
  localNonce: Uint8Array;
  remoteNonce: Uint8Array;
}): Promise<CryptoKey> {
  const {
    algorithm,
    privateKey,
    localPublicKey,
    remotePublicKey,
    localNonce,
    remoteNonce,
  } = args;
  if (localNonce.length !== 32 || remoteNonce.length !== 32) {
    throw new Error("Handshake nonces must each be 32 bytes");
  }

  const publicPair = [localPublicKey, remotePublicKey].sort(compareBytes);
  const noncePair = [localNonce, remoteNonce].sort(compareBytes);
  const saltMaterial = concatBytes(
    SALT_PREFIX,
    ...publicPair.map(withLengthPrefix),
    ...noncePair.map(withLengthPrefix),
  );
  const salt = await crypto.subtle.digest(
    "SHA-256",
    toArrayBuffer(saltMaterial),
  );
  const peerAlgorithm =
    algorithm === "X25519"
      ? { name: "X25519" }
      : { name: "ECDH", namedCurve: "P-256" };
  const remoteKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(remotePublicKey),
    peerAlgorithm,
    false,
    [],
  );
  const sharedSecret = await crypto.subtle.deriveBits(
    {
      name: algorithm === "X25519" ? "X25519" : "ECDH",
      public: remoteKey,
    } as EcdhKeyDeriveParams,
    privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: toArrayBuffer(SESSION_INFO) },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
