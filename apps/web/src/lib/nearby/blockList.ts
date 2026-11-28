const STORAGE_KEY = "zerocloud.nearby.blocked-fingerprints";

export function loadBlockedFingerprints(): Set<string> {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return new Set();
    return new Set(Object.keys(raw).filter((value) => /^[a-f0-9]{64}$/.test(value)));
  } catch { return new Set(); }
}

export function saveBlockedFingerprints(fingerprints: Set<string>): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries([...fingerprints].map((fingerprint) => [fingerprint, true]))));
}
