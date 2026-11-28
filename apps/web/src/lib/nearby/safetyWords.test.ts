import { describe, expect, it } from "vitest";
import { SAS_WORDLIST_V1, SAS_WORDLIST_VERSION } from "./sas-wordlist-v1";
import { deriveSafetyWords } from "./safetyWords";

describe("SAS v1", () => {
  it("pins the versioned list and its exact contents", async () => {
    expect(SAS_WORDLIST_VERSION).toBe("sas-wordlist-v1");
    expect(SAS_WORDLIST_V1).toHaveLength(2048);
    expect(new Set(SAS_WORDLIST_V1).size).toBe(2048);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SAS_WORDLIST_V1.join("\n")));
    expect([...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")).toBe("540cc29920c78486181be4361d1f428bfed99ca0ec3d4a2b20d86fc40783c0e2");
  });
  it("matches two known-answer vectors and sorts each pair independently", async () => {
    const first = await deriveSafetyWords("00".repeat(32), "11".repeat(32), new Uint8Array(32).fill(0x22), new Uint8Array(32).fill(0x33));
    expect(first).toEqual(["mellow-acorn", "kind-finch", "vivid-birch", "warm-glade"]);
    expect(await deriveSafetyWords("11".repeat(32), "00".repeat(32), new Uint8Array(32).fill(0x33), new Uint8Array(32).fill(0x22))).toEqual(first);
    expect(await deriveSafetyWords("00".repeat(32), "11".repeat(32), new Uint8Array(32).fill(0x22), new Uint8Array(32).fill(0x34))).not.toEqual(first);
    expect(await deriveSafetyWords("00".repeat(32), "12".repeat(32), new Uint8Array(32).fill(0x22), new Uint8Array(32).fill(0x33))).not.toEqual(first);
    expect(await deriveSafetyWords("ff".repeat(32), "01".repeat(32), new Uint8Array(32).fill(0xa5), new Uint8Array(32).fill(0x5a))).toEqual(["fresh-echo", "warm-garden", "bold-echo", "jolly-north"]);
  });
});
