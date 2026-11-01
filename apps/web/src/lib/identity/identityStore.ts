import {
  fingerprintPublicKey,
  generateIdentityKeyPair,
  type IdentityAlgorithm,
  type IdentityKeyPair,
} from "@zerocloud/shared";

export type StoredIdentity = IdentityKeyPair & { fingerprint: string };
type IdentityRecord = {
  id: "identity";
  algorithm: IdentityAlgorithm;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyRaw: ArrayBuffer;
  fingerprint: string;
};
type IdentityLockRecord = { id: "identity-lock"; owner: string; startedAt: number };
type AcquireResult =
  | { kind: "found"; record: IdentityRecord }
  | { kind: "wait" }
  | { kind: "claimed"; clearVerified: boolean };

const DATABASE_NAME = "zerocloud-identity";
const STORE_NAME = "records";
const PINS_STORE_NAME = "workspace-member-pins";
let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains(PINS_STORE_NAME)) {
        request.result.createObjectStore(PINS_STORE_NAME, { keyPath: ["workspaceId", "userId"] });
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Could not open identity database"));
    request.onblocked = () =>
      reject(new Error("Identity database upgrade is blocked"));
  });
  return databasePromise;
}

export type WorkspaceMemberPin = {
  workspaceId: string;
  userId: string;
  fingerprint: string;
  publicKey: string;
};

export type PinResult = "pinned" | "match" | "mismatch" | "invalid";

export async function pinWorkspaceMemberKey(
  candidate: WorkspaceMemberPin,
): Promise<PinResult> {
  let actual: string;
  try {
    actual = await fingerprintPublicKey(
      Uint8Array.from(atob(candidate.publicKey), (char) => char.charCodeAt(0)),
    );
  } catch {
    return "invalid";
  }
  if (actual !== candidate.fingerprint) return "invalid";
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(PINS_STORE_NAME, "readwrite");
    const store = transaction.objectStore(PINS_STORE_NAME);
    const request = store.get([candidate.workspaceId, candidate.userId]);
    let result: PinResult = "pinned";
    request.onsuccess = () => {
      const existing = request.result as WorkspaceMemberPin | undefined;
      if (!existing) store.add(candidate);
      else result = existing.fingerprint === candidate.fingerprint && existing.publicKey === candidate.publicKey ? "match" : "mismatch";
    };
    request.onerror = () => reject(request.error ?? new Error("Could not read member key pin"));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not store member key pin"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Member key pin operation was aborted"));
  });
}

export async function confirmWorkspaceMemberKeyPinUpdate(
  candidate: WorkspaceMemberPin,
): Promise<void> {
  const result = await pinWorkspaceMemberKey(candidate);
  if (result === "invalid") throw new Error("Member public key fingerprint is invalid");
  if (result === "mismatch") {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(PINS_STORE_NAME, "readwrite");
      transaction.objectStore(PINS_STORE_NAME).put(candidate);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not update member key pin"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Member key pin update was aborted"));
    });
  }
}

async function readRecord<T>(id: string): Promise<T | undefined> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () =>
      reject(request.error ?? new Error("Could not read identity data"));
  });
}

export async function getOrCreateIdentity(
  forceP256 = false,
): Promise<StoredIdentity> {
  const owner = crypto.randomUUID();
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const acquired = await acquireIdentitySlot(owner, forceP256);
    if (acquired.kind === "found") return toStoredIdentity(acquired.record);
    if (acquired.kind === "wait") {
      await new Promise((resolve) => setTimeout(resolve, 75));
      continue;
    }

    try {
      const pair = await generateIdentityKeyPair(forceP256);
      const fingerprint = await fingerprintPublicKey(pair.publicKeyRaw);
      const record: IdentityRecord = {
        id: "identity",
        algorithm: pair.algorithm,
        privateKey: pair.privateKey,
        publicKey: pair.publicKey,
        publicKeyRaw: pair.publicKeyRaw.slice().buffer as ArrayBuffer,
        fingerprint,
      };
      if (await commitIdentity(owner, record, acquired.clearVerified)) {
        return { ...pair, fingerprint };
      }
    } catch (error) {
      await releaseIdentitySlot(owner);
      throw error;
    }
  }
  throw new Error("Timed out preparing the browser identity");
}

function toStoredIdentity(record: IdentityRecord): StoredIdentity {
  return {
    algorithm: record.algorithm,
    privateKey: record.privateKey,
    publicKey: record.publicKey,
    publicKeyRaw: new Uint8Array(record.publicKeyRaw),
    fingerprint: record.fingerprint,
  };
}

async function acquireIdentitySlot(owner: string, forceP256: boolean): Promise<AcquireResult> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const identityRequest = store.get("identity");
    const lockRequest = store.get("identity-lock");
    let identity: IdentityRecord | undefined;
    let lock: IdentityLockRecord | undefined;
    let loaded = 0;
    let result: AcquireResult | null = null;
    const inspect = (): void => {
      loaded += 1;
      if (loaded !== 2) return;
      if (identity && !(forceP256 && identity.algorithm !== "P-256")) {
        result = { kind: "found", record: identity };
        return;
      }
      if (lock && Date.now() - lock.startedAt < 30_000) {
        result = { kind: "wait" };
        return;
      }
      result = { kind: "claimed", clearVerified: Boolean(identity && forceP256) };
      store.put({ id: "identity-lock", owner, startedAt: Date.now() } satisfies IdentityLockRecord);
    };
    identityRequest.onsuccess = () => { identity = identityRequest.result as IdentityRecord | undefined; inspect(); };
    lockRequest.onsuccess = () => { lock = lockRequest.result as IdentityLockRecord | undefined; inspect(); };
    identityRequest.onerror = () => reject(identityRequest.error ?? new Error("Could not read browser identity"));
    lockRequest.onerror = () => reject(lockRequest.error ?? new Error("Could not coordinate browser identity creation"));
    transaction.oncomplete = () => resolve(result ?? { kind: "wait" });
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not coordinate browser identity creation"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Identity creation coordination was aborted"));
  });
}

async function commitIdentity(owner: string, record: IdentityRecord, clearVerified: boolean): Promise<boolean> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get("identity-lock");
    let committed = false;
    request.onsuccess = () => {
      const lock = request.result as IdentityLockRecord | undefined;
      if (lock?.owner !== owner) return;
      store.put(record);
      store.delete("identity-lock");
      if (clearVerified) store.delete("verified");
      committed = true;
    };
    request.onerror = () => reject(request.error ?? new Error("Could not finalize browser identity"));
    transaction.oncomplete = () => resolve(committed);
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save browser identity"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Saving browser identity was aborted"));
  });
}

async function releaseIdentitySlot(owner: string): Promise<void> {
  try {
    const database = await openDatabase();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get("identity-lock");
      request.onsuccess = () => {
        const lock = request.result as IdentityLockRecord | undefined;
        if (lock?.owner === owner) store.delete("identity-lock");
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("Could not release identity creation lock"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Identity lock release was aborted"));
    });
  } catch {
    // The next tab can recover the lock after its expiry.
  }
}

export async function loadVerifiedFingerprints(): Promise<Set<string>> {
  const record = await readRecord<{ id: "verified"; fingerprints: string[] }>(
    "verified",
  );
  return new Set(record?.fingerprints ?? []);
}

export async function saveVerifiedFingerprint(
  fingerprint: string,
): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get("verified");
    request.onsuccess = () => {
      const existing = request.result as { fingerprints?: string[] } | undefined;
      const fingerprints = new Set(existing?.fingerprints ?? []);
      fingerprints.add(fingerprint);
      store.put({ id: "verified", fingerprints: [...fingerprints] });
    };
    request.onerror = () => reject(request.error ?? new Error("Could not read verified fingerprints"));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not save verified fingerprint"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Saving verified fingerprint was aborted"));
  });
}

export async function resetIdentity(): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    store.delete("identity");
    store.delete("verified");
    store.delete("identity-lock");
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("Could not reset identity"));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("Resetting identity was aborted"));
  });
}
