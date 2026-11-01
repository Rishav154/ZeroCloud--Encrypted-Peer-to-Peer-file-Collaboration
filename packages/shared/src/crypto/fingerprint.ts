import { toArrayBuffer } from "./encoding.js";

export async function fingerprintPublicKey(
  rawPublicKey: Uint8Array,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    toArrayBuffer(rawPublicKey),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function formatFingerprint(fingerprint: string): string {
  return (
    fingerprint
      .slice(0, 32)
      .match(/.{1,4}/g)
      ?.join(" ") ?? ""
  );
}
