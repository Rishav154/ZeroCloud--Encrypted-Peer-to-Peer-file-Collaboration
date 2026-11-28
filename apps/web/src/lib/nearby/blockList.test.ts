import { afterEach, describe, expect, it, vi } from "vitest";
import { loadBlockedFingerprints, saveBlockedFingerprints } from "./blockList";

describe("nearby block list", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("persists blocks by fingerprint across reloads and rejects malformed keys", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
    const fingerprint = "a".repeat(64);
    saveBlockedFingerprints(new Set([fingerprint]));
    expect(loadBlockedFingerprints()).toEqual(new Set([fingerprint]));
    values.set("zerocloud.nearby.blocked-fingerprints", JSON.stringify({ bad: true, [fingerprint]: true }));
    expect(loadBlockedFingerprints()).toEqual(new Set([fingerprint]));
  });
});
