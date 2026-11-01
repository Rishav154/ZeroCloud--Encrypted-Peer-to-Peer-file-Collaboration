import type { IdentityAlgorithm } from "../index.js";
import {
  base64ToBytes,
  bytesToBase64,
  compareBytes,
  concatBytes,
  toArrayBuffer,
  utf8,
  withLengthPrefix,
} from "./encoding.js";
import { open, seal } from "./seal.js";

const WRAP_SALT_PREFIX = utf8("zerocloud/v1/wrap-salt");
const WRAP_INFO = utf8("zerocloud/v1/wrap");
const WRAPPED_KEY_AAD_PREFIX = utf8("zerocloud/v1/wrapped-ws-key");
const WORKSPACE_NAME_AAD_PREFIX = utf8("zerocloud/v1/ws-name");
const INVITE_INFO = utf8("zerocloud/v1/invite");
const INVITE_KEY_AAD_PREFIX = utf8("zerocloud/v1/invite-key");

type WrapContext = {
  wrapperPublicKeyRaw: Uint8Array;
  recipientPublicKeyRaw: Uint8Array;
  algorithm: IdentityAlgorithm;
  workspaceId: string;
  keyVersion: number;
  wrapperFingerprint: string;
  recipientFingerprint: string;
};

export async function generateWorkspaceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

function nameAad(workspaceId: string): Uint8Array {
  return concatBytes(WORKSPACE_NAME_AAD_PREFIX, utf8(workspaceId));
}

export async function sealWorkspaceName(
  key: CryptoKey,
  workspaceId: string,
  name: string,
): Promise<string> {
  const envelope = await seal(key, utf8(name), nameAad(workspaceId));
  return bytesToBase64(envelope);
}

export async function openWorkspaceName(
  key: CryptoKey,
  workspaceId: string,
  sealed: string,
): Promise<string> {
  const plaintext = await open(
    key,
    base64ToBytes(sealed),
    nameAad(workspaceId),
  );
  return new TextDecoder().decode(plaintext);
}

function validateContext(context: WrapContext): void {
  if (
    !Number.isInteger(context.keyVersion) ||
    context.keyVersion < 1 ||
    context.keyVersion > 0xffffffff
  ) {
    throw new RangeError("Key version must be a positive uint32 integer");
  }
}

function wrappedKeyAad(context: WrapContext): Uint8Array {
  validateContext(context);
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, context.keyVersion, false);
  return concatBytes(
    WRAPPED_KEY_AAD_PREFIX,
    utf8(context.workspaceId),
    version,
    utf8(context.wrapperFingerprint),
    utf8(context.recipientFingerprint),
  );
}

async function deriveWrapKey(
  privateKey: CryptoKey,
  remotePublicKeyRaw: Uint8Array,
  context: WrapContext,
): Promise<CryptoKey> {
  validateContext(context);
  const publicPair = [
    context.wrapperPublicKeyRaw,
    context.recipientPublicKeyRaw,
  ].sort(compareBytes);
  const saltMaterial = concatBytes(
    WRAP_SALT_PREFIX,
    ...publicPair.map(withLengthPrefix),
  );
  const salt = await crypto.subtle.digest(
    "SHA-256",
    toArrayBuffer(saltMaterial),
  );
  const keyAlgorithm =
    context.algorithm === "X25519"
      ? { name: "X25519" }
      : { name: "ECDH", namedCurve: "P-256" };
  const remotePublicKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(remotePublicKeyRaw),
    keyAlgorithm,
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    {
      name: context.algorithm === "X25519" ? "X25519" : "ECDH",
      public: remotePublicKey,
    } as EcdhKeyDeriveParams,
    privateKey,
    256,
  );
  const hkdfKey = await crypto.subtle.importKey(
    "raw",
    sharedBits,
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: toArrayBuffer(WRAP_INFO),
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function wrapWorkspaceKey(
  workspaceKey: CryptoKey,
  wrapperPrivateKey: CryptoKey,
  context: WrapContext,
): Promise<string> {
  const remotePublicKeyRaw = context.recipientPublicKeyRaw;
  const wrappingKey = await deriveWrapKey(
    wrapperPrivateKey,
    remotePublicKeyRaw,
    context,
  );
  const rawWorkspaceKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", workspaceKey),
  );
  try {
    const envelope = await seal(
      wrappingKey,
      rawWorkspaceKey,
      wrappedKeyAad(context),
    );
    return bytesToBase64(envelope);
  } finally {
    rawWorkspaceKey.fill(0);
  }
}

export async function unwrapWorkspaceKey(
  wrappedKey: string,
  recipientPrivateKey: CryptoKey,
  context: WrapContext,
): Promise<CryptoKey> {
  const wrappingKey = await deriveWrapKey(
    recipientPrivateKey,
    context.wrapperPublicKeyRaw,
    context,
  );
  const rawWorkspaceKey = await open(
    wrappingKey,
    base64ToBytes(wrappedKey),
    wrappedKeyAad(context),
  );
  try {
    return await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(rawWorkspaceKey),
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"],
    );
  } finally {
    rawWorkspaceKey.fill(0);
  }
}

function uuidBytes(value: string): Uint8Array {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error("Workspace and invite IDs must be UUIDs");
  }
  const hex = value.replaceAll("-", "");
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

function inviteAad(
  workspaceId: string,
  inviteId: string,
  keyVersion: number,
): Uint8Array {
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 0xffffffff) {
    throw new RangeError("Key version must be a positive uint32 integer");
  }
  const version = new Uint8Array(4);
  new DataView(version.buffer).setUint32(0, keyVersion, false);
  return concatBytes(
    INVITE_KEY_AAD_PREFIX,
    uuidBytes(workspaceId),
    uuidBytes(inviteId),
    version,
  );
}

async function deriveInviteKey(
  secret: Uint8Array,
  inviteId: string,
): Promise<CryptoKey> {
  if (secret.byteLength !== 32) {
    throw new Error("Invite secret must contain exactly 32 bytes");
  }
  const baseKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(uuidBytes(inviteId)),
      info: toArrayBuffer(INVITE_INFO),
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealInviteWorkspaceKey(
  workspaceKey: CryptoKey,
  inviteSecret: Uint8Array,
  workspaceId: string,
  inviteId: string,
  keyVersion: number,
): Promise<string> {
  const inviteKey = await deriveInviteKey(inviteSecret, inviteId);
  const rawWorkspaceKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", workspaceKey),
  );
  try {
    return bytesToBase64(
      await seal(
        inviteKey,
        rawWorkspaceKey,
        inviteAad(workspaceId, inviteId, keyVersion),
      ),
    );
  } finally {
    rawWorkspaceKey.fill(0);
  }
}

export async function openInviteWorkspaceKey(
  sealed: string,
  inviteSecret: Uint8Array,
  workspaceId: string,
  inviteId: string,
  keyVersion: number,
): Promise<CryptoKey> {
  const inviteKey = await deriveInviteKey(inviteSecret, inviteId);
  const rawWorkspaceKey = await open(
    inviteKey,
    base64ToBytes(sealed),
    inviteAad(workspaceId, inviteId, keyVersion),
  );
  try {
    return await crypto.subtle.importKey(
      "raw",
      toArrayBuffer(rawWorkspaceKey),
      { name: "AES-GCM" },
      true,
      ["encrypt", "decrypt"],
    );
  } finally {
    rawWorkspaceKey.fill(0);
  }
}
