import { base64ToBytes, bytesToBase64, utf8 } from "@zerocloud/shared";

export async function commitHello(exactHello: string): Promise<string> {
  const bytes = utf8(exactHello);
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer)));
}

export async function verifyHelloCommit(exactHello: string, commitment: string): Promise<boolean> {
  if (commitment.length > 128) return false;
  try {
    const expected = base64ToBytes(await commitHello(exactHello)); const actual = base64ToBytes(commitment);
    if (actual.length !== 32 || expected.length !== actual.length) return false;
    return expected.every((byte, index) => byte === actual[index]);
  } catch { return false; }
}
