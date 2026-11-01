import { beforeAll, describe, expect, it } from "vitest";
import {
  AesGcmChunkTransform,
  base64ToBytes,
  buildAad,
  bytesToBase64,
  deriveSessionKey,
  fingerprintPublicKey,
  generateIdentityKeyPair,
  open,
  seal,
  utf8,
} from "./index.js";
import type { IdentityAlgorithm } from "../index.js";
import type { IdentityKeyPair } from "./identity.js";

let supportsX25519 = false;

beforeAll(async () => {
  supportsX25519 = (await generateIdentityKeyPair()).algorithm === "X25519";
});

async function derivePair(
  algorithm: IdentityAlgorithm,
  local: IdentityKeyPair,
  remote: IdentityKeyPair,
  localNonce: Uint8Array,
  remoteNonce: Uint8Array,
): Promise<CryptoKey> {
  return deriveSessionKey({
    algorithm,
    privateKey: local.privateKey,
    localPublicKey: local.publicKeyRaw,
    remotePublicKey: remote.publicKeyRaw,
    localNonce,
    remoteNonce,
  });
}

function randomNonce(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

describe("identity key derivation", () => {
  it("derives a shared X25519 session key when the runtime supports it", async () => {
    if (!supportsX25519) return;
    const a = await generateIdentityKeyPair();
    const b = await generateIdentityKeyPair();
    expect(a.algorithm).toBe("X25519");
    expect(b.algorithm).toBe("X25519");
    const nonceA = randomNonce();
    const nonceB = randomNonce();
    const keyA = await derivePair("X25519", a, b, nonceA, nonceB);
    const keyB = await derivePair("X25519", b, a, nonceB, nonceA);
    const fpA = await fingerprintPublicKey(a.publicKeyRaw);
    const fpB = await fingerprintPublicKey(b.publicKeyRaw);
    const aadA = buildAad({
      context: "ready",
      senderFingerprint: fpA,
      receiverFingerprint: fpB,
      senderNonce: nonceA,
      receiverNonce: nonceB,
    });
    const aadB = buildAad({
      context: "ready",
      senderFingerprint: fpA,
      receiverFingerprint: fpB,
      senderNonce: nonceA,
      receiverNonce: nonceB,
    });
    const envelope = await seal(keyA, utf8("ready"), aadA);
    expect(await open(keyB, envelope, aadB)).toEqual(utf8("ready"));
  });

  it("derives a shared P-256 session key", async () => {
    const a = await generateIdentityKeyPair(true);
    const b = await generateIdentityKeyPair(true);
    const nonceA = randomNonce();
    const nonceB = randomNonce();
    const keyA = await derivePair("P-256", a, b, nonceA, nonceB);
    const keyB = await derivePair("P-256", b, a, nonceB, nonceA);
    const fpA = await fingerprintPublicKey(a.publicKeyRaw);
    const fpB = await fingerprintPublicKey(b.publicKeyRaw);
    const envelope = await seal(
      keyA,
      utf8("ready"),
      buildAad({
        context: "ready",
        senderFingerprint: fpA,
        receiverFingerprint: fpB,
        senderNonce: nonceA,
        receiverNonce: nonceB,
      }),
    );
    expect(
      await open(
        keyB,
        envelope,
        buildAad({
          context: "ready",
          senderFingerprint: fpA,
          receiverFingerprint: fpB,
          senderNonce: nonceA,
          receiverNonce: nonceB,
        }),
      ),
    ).toEqual(utf8("ready"));
  });

  it("supports two tabs with the same identity and binds messages to direction", async () => {
    const identity = await generateIdentityKeyPair(true);
    const nonceA = randomNonce();
    const nonceB = randomNonce();
    const keyA = await derivePair("P-256", identity, identity, nonceA, nonceB);
    const keyB = await derivePair("P-256", identity, identity, nonceB, nonceA);
    const fingerprint = await fingerprintPublicKey(identity.publicKeyRaw);
    const fromAToB = buildAad({
      context: "ready",
      senderFingerprint: fingerprint,
      receiverFingerprint: fingerprint,
      senderNonce: nonceA,
      receiverNonce: nonceB,
    });
    const fromBToA = buildAad({
      context: "ready",
      senderFingerprint: fingerprint,
      receiverFingerprint: fingerprint,
      senderNonce: nonceB,
      receiverNonce: nonceA,
    });
    const envelope = await seal(keyA, utf8("ready"), fromAToB);
    expect(await open(keyB, envelope, fromAToB)).toEqual(utf8("ready"));
    await expect(open(keyB, envelope, fromBToA)).rejects.toThrow();
  });

  it("changes the session key for each connection nonce pair", async () => {
    const a = await generateIdentityKeyPair(true);
    const b = await generateIdentityKeyPair(true);
    const key1 = await derivePair("P-256", a, b, randomNonce(), randomNonce());
    const key2 = await derivePair("P-256", a, b, randomNonce(), randomNonce());
    const aad = new Uint8Array();
    const encrypted = await seal(key1, utf8("bound"), aad);
    await expect(open(key2, encrypted, aad)).rejects.toThrow();
  });

  it("has stable fingerprints that differ between identities", async () => {
    const a = await generateIdentityKeyPair(true);
    const b = await generateIdentityKeyPair(true);
    const first = await fingerprintPublicKey(a.publicKeyRaw);
    expect(await fingerprintPublicKey(a.publicKeyRaw)).toBe(first);
    expect(await fingerprintPublicKey(b.publicKeyRaw)).not.toBe(first);
  });

  it("keeps generated private identity keys non-extractable", async () => {
    const identity = await generateIdentityKeyPair(true);
    expect(identity.privateKey.extractable).toBe(false);
    await expect(
      crypto.subtle.exportKey("pkcs8", identity.privateKey),
    ).rejects.toThrow();
  });

  it("rejects non-32-byte connection nonces", async () => {
    const identity = await generateIdentityKeyPair(true);
    const nonce = randomNonce();
    await expect(
      derivePair("P-256", identity, identity, nonce.subarray(1), nonce),
    ).rejects.toThrow("32 bytes");
  });
});

describe("sealed envelopes", () => {
  async function aesKey(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  it("round trips and rejects wrong keys, AAD, IV, ciphertext, and tag", async () => {
    const key = await aesKey();
    const wrongKey = await aesKey();
    const aad = utf8("context-aad");
    const plaintext = utf8("private metadata");
    const envelope = await seal(key, plaintext, aad);
    expect(await open(key, envelope, aad)).toEqual(plaintext);
    await expect(open(wrongKey, envelope, aad)).rejects.toThrow();
    await expect(open(key, envelope, utf8("wrong-aad"))).rejects.toThrow();
    for (const index of [0, 12, envelope.length - 1]) {
      const changed = envelope.slice();
      changed[index] = changed[index]! ^ 1;
      await expect(open(key, changed, aad)).rejects.toThrow();
    }
  });

  it("round trips base64 key and envelope bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("binds a sealed offer to its sender fingerprint", async () => {
    const key = await aesKey();
    const sender = "a".repeat(64);
    const recipient = "b".repeat(64);
    const nonceA = randomNonce();
    const nonceB = randomNonce();
    const aad = buildAad({
      context: "file-offer",
      senderFingerprint: sender,
      receiverFingerprint: recipient,
      senderNonce: nonceA,
      receiverNonce: nonceB,
      transferId: 4,
    });
    const envelope = await seal(key, utf8("sealed offer"), aad);
    const reversed = buildAad({
      context: "file-offer",
      senderFingerprint: recipient,
      receiverFingerprint: sender,
      senderNonce: nonceB,
      receiverNonce: nonceA,
      transferId: 4,
    });
    await expect(open(key, envelope, reversed)).rejects.toThrow();
  });
});

describe("AES-GCM file chunk transform", () => {
  async function key(): Promise<CryptoKey> {
    return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
      "encrypt",
      "decrypt",
    ]);
  }

  it.each([0, 1, 16_384])("round trips a %i-byte chunk", async (size) => {
    const plain = crypto.getRandomValues(new Uint8Array(size));
    const cipher = new AesGcmChunkTransform(await key(), 1, 2);
    const encoded = await cipher.encode(plain, { transferId: 2, index: 0 });
    expect(encoded.length).toBe(size + 16);
    expect(await cipher.decode(encoded, { transferId: 2, index: 0 })).toEqual(
      plain,
    );
  });

  it("rejects changed ciphertext and mismatched transfer, index, or totalChunks", async () => {
    const fileKey = await key();
    const cipher = new AesGcmChunkTransform(fileKey, 2, 10);
    const encoded = await cipher.encode(utf8("first"), {
      transferId: 10,
      index: 0,
    });
    const changed = encoded.slice();
    changed[0] = changed[0]! ^ 1;
    await expect(
      cipher.decode(changed, { transferId: 10, index: 0 }),
    ).rejects.toThrow();
    await expect(
      cipher.decode(encoded, { transferId: 11, index: 0 }),
    ).rejects.toThrow();
    await expect(
      cipher.decode(encoded, { transferId: 10, index: 1 }),
    ).rejects.toThrow();
    await expect(
      new AesGcmChunkTransform(fileKey, 3, 10).decode(encoded, {
        transferId: 10,
        index: 0,
      }),
    ).rejects.toThrow();
  });

  it("rejects chunks swapped out of order", async () => {
    const transform = new AesGcmChunkTransform(await key(), 2, 8);
    const first = await transform.encode(utf8("first"), {
      transferId: 8,
      index: 0,
    });
    const second = await transform.encode(utf8("second"), {
      transferId: 8,
      index: 1,
    });
    await expect(
      transform.decode(second, { transferId: 8, index: 0 }),
    ).rejects.toThrow();
    await expect(
      transform.decode(first, { transferId: 8, index: 1 }),
    ).rejects.toThrow();
  });
});
