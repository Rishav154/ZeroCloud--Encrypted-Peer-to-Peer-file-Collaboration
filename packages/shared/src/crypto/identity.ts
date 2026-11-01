import type { IdentityAlgorithm } from "../index.js";

export type IdentityKeyPair = {
  algorithm: IdentityAlgorithm;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyRaw: Uint8Array;
};

export async function generateIdentityKeyPair(
  forceP256 = false,
): Promise<IdentityKeyPair> {
  if (!forceP256) {
    try {
      const pair = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
        "deriveBits",
      ])) as CryptoKeyPair;
      const publicKeyRaw = new Uint8Array(
        await crypto.subtle.exportKey("raw", pair.publicKey),
      );
      return {
        algorithm: "X25519",
        privateKey: pair.privateKey,
        publicKey: pair.publicKey,
        publicKeyRaw,
      };
    } catch {
      // Use the broadly supported curve if X25519 key generation is unavailable.
    }
  }

  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const publicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    algorithm: "P-256",
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyRaw,
  };
}
