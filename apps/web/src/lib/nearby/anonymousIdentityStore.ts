import { fingerprintPublicKey, generateIdentityKeyPair, type IdentityKeyPair } from "@zerocloud/shared";

const DB = "zerocloud-anonymous-nearby";
const STORE = "device-key-v1";
type RecordValue = { id: "device"; algorithm: IdentityKeyPair["algorithm"]; privateKey: CryptoKey; publicKey: CryptoKey; publicKeyRaw: ArrayBuffer; fingerprint: string };
export type AnonymousIdentity = IdentityKeyPair & { fingerprint: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "id" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open nearby key storage"));
  });
}
export async function getAnonymousIdentity(): Promise<AnonymousIdentity> {
  const db = await openDb();
  const existing = await new Promise<RecordValue | undefined>((resolve, reject) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get("device");
    request.onsuccess = () => resolve(request.result as RecordValue | undefined);
    request.onerror = () => reject(request.error ?? new Error("Could not read nearby key"));
  });
  if (existing) return { algorithm: existing.algorithm, privateKey: existing.privateKey, publicKey: existing.publicKey, publicKeyRaw: new Uint8Array(existing.publicKeyRaw), fingerprint: existing.fingerprint };
  const pair = await generateIdentityKeyPair();
  const fingerprint = await fingerprintPublicKey(pair.publicKeyRaw);
  const record: RecordValue = { id: "device", algorithm: pair.algorithm, privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyRaw: pair.publicKeyRaw.slice().buffer as ArrayBuffer, fingerprint };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite"); tx.objectStore(STORE).add(record);
    tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error ?? new Error("Could not store nearby key")); tx.onabort = () => reject(tx.error ?? new Error("Nearby key storage aborted"));
  }).catch(async () => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get("device");
    const winner = await new Promise<RecordValue | undefined>((resolve, reject) => { request.onsuccess = () => resolve(request.result as RecordValue | undefined); request.onerror = () => reject(request.error ?? new Error("Could not read nearby key")); });
    if (!winner) throw new Error("Nearby key creation failed");
    return winner;
  });
  const stored = await new Promise<RecordValue | undefined>((resolve, reject) => { const request = db.transaction(STORE, "readonly").objectStore(STORE).get("device"); request.onsuccess = () => resolve(request.result as RecordValue | undefined); request.onerror = () => reject(request.error ?? new Error("Could not read nearby key")); });
  if (stored && stored.fingerprint !== fingerprint) return { algorithm: stored.algorithm, privateKey: stored.privateKey, publicKey: stored.publicKey, publicKeyRaw: new Uint8Array(stored.publicKeyRaw), fingerprint: stored.fingerprint };
  return { ...pair, fingerprint };
}
