import { SAS_WORDLIST_V1 } from "./sas-wordlist-v1";

export const SAS_CONTEXT = "sas-wordlist-v1" as const;
export async function deriveSafetyWords(fingerprintA: string, fingerprintB: string, nonceA: Uint8Array, nonceB: Uint8Array): Promise<readonly string[]> {
  if (nonceA.length !== 32 || nonceB.length !== 32 || SAS_WORDLIST_V1.length !== 2048) throw new Error("Invalid safety-word input");
  const fpA = hexToBytes(fingerprintA); const fpB = hexToBytes(fingerprintB);
  const fingerprints = compare(fpA, fpB) <= 0 ? [fpA, fpB] : [fpB, fpA];
  const nonces = compare(nonceA, nonceB) <= 0 ? [nonceA, nonceB] : [nonceB, nonceA];
  const prefix = new TextEncoder().encode("zerocloud/v1/sas");
  const input = new Uint8Array(prefix.length + 128); input.set(prefix);
  let offset = prefix.length; for (const field of [...fingerprints, ...nonces]) { input.set(field, offset); offset += 32; }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const result: string[] = [];
  for (let word = 0; word < 4; word += 1) {
    let index = 0;
    for (let bit = 0; bit < 11; bit += 1) { const position = word * 11 + bit; index = (index << 1) | (((digest[position >> 3] ?? 0) >> (7 - (position & 7))) & 1); }
    result.push(SAS_WORDLIST_V1[index] ?? "");
  }
  return result;
}
function compare(a: Uint8Array, b: Uint8Array): number { for (let i = 0; i < Math.min(a.length, b.length); i += 1) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0); return a.length - b.length; }
function hexToBytes(value: string): Uint8Array { if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error("Invalid fingerprint"); return Uint8Array.from(value.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16)); }
