import { describe, expect, it } from "vitest";
import {
  concatBytes,
  bytesToBase64,
  createWorkspaceProofDigest,
  deriveWorkspaceNameKey,
  deriveWorkspaceSyncKey,
  fingerprintPublicKey,
  generateIdentityKeyPair,
  generateWorkspaceKey,
  openInviteWorkspaceKey,
  openWorkspaceName,
  sealWorkspaceName,
  sealInviteWorkspaceKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
  utf8,
} from "./index.js";
import { seal } from "./seal.js";

async function keyBytes(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

async function makeContext(
  algorithm: "X25519" | "P-256",
  wrapperInput?: Awaited<ReturnType<typeof generateIdentityKeyPair>>,
  recipientInput?: Awaited<ReturnType<typeof generateIdentityKeyPair>>,
) {
  const wrapper =
    wrapperInput ?? (await generateIdentityKeyPair(algorithm === "P-256"));
  const recipient = recipientInput ?? wrapper;
  return {
    wrapper,
    recipient,
    args: {
      wrapperPublicKeyRaw: wrapper.publicKeyRaw,
      recipientPublicKeyRaw: recipient.publicKeyRaw,
      algorithm,
      workspaceId: crypto.randomUUID(),
      keyVersion: 1,
      wrapperFingerprint: await fingerprintPublicKey(wrapper.publicKeyRaw),
      recipientFingerprint: await fingerprintPublicKey(recipient.publicKeyRaw),
    } as const,
  };
}

describe("workspace key wrapping", () => {
  it("rejects a reflected workspace proof, including same-identity tabs", async () => {
    const firstNonce = new Uint8Array(32).fill(11);
    const secondNonce = new Uint8Array(32).fill(29);
    const sharedFingerprint = "a".repeat(64);
    const sent = await createWorkspaceProofDigest(firstNonce, secondNonce, sharedFingerprint, sharedFingerprint);
    const reflected = await createWorkspaceProofDigest(secondNonce, firstNonce, sharedFingerprint, sharedFingerprint);
    expect(sent).not.toEqual(reflected);
    const different = await createWorkspaceProofDigest(secondNonce, firstNonce, "b".repeat(64), "a".repeat(64));
    expect(sent).not.toEqual(different);
  });

  it.each(["X25519", "P-256"] as const)(
    "wraps and unwraps with %s, including self-wrap",
    async (algorithm) => {
      const context = await makeContext(algorithm);
      const workspaceKey = await generateWorkspaceKey();
      const wrapped = await wrapWorkspaceKey(
        workspaceKey,
        context.wrapper.privateKey,
        context.args,
      );
      const unwrapped = await unwrapWorkspaceKey(
        wrapped,
        context.recipient.privateKey,
        context.args,
      );
      expect(await keyBytes(unwrapped)).toEqual(await keyBytes(workspaceKey));
      expect(unwrapped.extractable).toBe(true);
    },
  );

  it("wraps for another identity and rejects a wrong recipient", async () => {
    const wrapper = await generateIdentityKeyPair();
    const recipient = await generateIdentityKeyPair();
    const wrongRecipient = await generateIdentityKeyPair();
    const context = await makeContext("X25519", wrapper, recipient);
    const workspaceKey = await generateWorkspaceKey();
    const wrapped = await wrapWorkspaceKey(
      workspaceKey,
      wrapper.privateKey,
      context.args,
    );
    const unwrapped = await unwrapWorkspaceKey(
      wrapped,
      recipient.privateKey,
      context.args,
    );
    expect(await keyBytes(unwrapped)).toEqual(await keyBytes(workspaceKey));
    await expect(
      unwrapWorkspaceKey(wrapped, wrongRecipient.privateKey, {
        ...context.args,
        recipientPublicKeyRaw: wrongRecipient.publicKeyRaw,
        recipientFingerprint: await fingerprintPublicKey(
          wrongRecipient.publicKeyRaw,
        ),
      }),
    ).rejects.toThrow();
  });

  it("binds the envelope to workspace, version, and both fingerprints", async () => {
    const context = await makeContext("P-256");
    const workspaceKey = await generateWorkspaceKey();
    const wrapped = await wrapWorkspaceKey(
      workspaceKey,
      context.wrapper.privateKey,
      context.args,
    );
    const changes = [
      { workspaceId: crypto.randomUUID() },
      { keyVersion: 2 },
      { wrapperFingerprint: "a".repeat(64) },
      { recipientFingerprint: "b".repeat(64) },
    ];
    for (const change of changes) {
      await expect(
        unwrapWorkspaceKey(wrapped, context.recipient.privateKey, {
          ...context.args,
          ...change,
        }),
      ).rejects.toThrow();
    }
  });

  it("seals workspace names to their workspace ID", async () => {
    const key = await generateWorkspaceKey();
    const workspaceId = crypto.randomUUID();
    const sealed = await sealWorkspaceName(key, workspaceId, "Research vault");
    await expect(openWorkspaceName(key, workspaceId, sealed)).resolves.toBe(
      "Research vault",
    );
    await expect(
      openWorkspaceName(key, crypto.randomUUID(), sealed),
    ).rejects.toThrow();
  });

  it("derives deterministic workspace keys that differ by version and workspace", async () => {
    const key = await generateWorkspaceKey();
    const workspaceId = crypto.randomUUID();
    const syncA = await deriveWorkspaceSyncKey(key, workspaceId, 1);
    const syncAAgain = await deriveWorkspaceSyncKey(key, workspaceId, 1);
    const syncVersion2 = await deriveWorkspaceSyncKey(key, workspaceId, 2);
    const syncOtherWorkspace = await deriveWorkspaceSyncKey(
      key,
      crypto.randomUUID(),
      1,
    );
    const probe = new Uint8Array([1, 2, 3]);
    const iv = new Uint8Array(12).fill(7);
    const aad = new Uint8Array([9]);
    const encrypt = (derived: CryptoKey): Promise<ArrayBuffer> =>
      crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: aad },
        derived,
        probe,
      );
    expect(new Uint8Array(await encrypt(syncA))).toEqual(
      new Uint8Array(await encrypt(syncAAgain)),
    );
    expect(new Uint8Array(await encrypt(syncA))).not.toEqual(
      new Uint8Array(await encrypt(syncVersion2)),
    );
    expect(new Uint8Array(await encrypt(syncA))).not.toEqual(
      new Uint8Array(await encrypt(syncOtherWorkspace)),
    );
    expect(syncA.extractable).toBe(false);
    const nameA = await deriveWorkspaceNameKey(key, workspaceId, 1);
    const nameB = await deriveWorkspaceNameKey(key, workspaceId, 1);
    expect(new Uint8Array(await encrypt(nameA))).toEqual(
      new Uint8Array(await encrypt(nameB)),
    );
  });

  it("opens legacy v1 names and writes versioned names with version-bound AAD", async () => {
    const key = await generateWorkspaceKey();
    const workspaceId = crypto.randomUUID();
    const legacy = await seal(
      key,
      utf8("Legacy name"),
      concatBytes(utf8("zerocloud/v1/ws-name"), utf8(workspaceId)),
    );
    const legacyBase64 = bytesToBase64(legacy);
    await expect(
      openWorkspaceName(key, workspaceId, legacyBase64, 1),
    ).resolves.toBe("Legacy name");

    const v2 = await sealWorkspaceName(key, workspaceId, "Rotated name", 2);
    await expect(openWorkspaceName(key, workspaceId, v2, 2)).resolves.toBe(
      "Rotated name",
    );
    await expect(openWorkspaceName(key, workspaceId, v2, 3)).rejects.toThrow();
    await expect(openWorkspaceName(key, crypto.randomUUID(), v2, 2)).rejects.toThrow();
  });

  it("opens invite envelopes only with the right secret and context", async () => {
    const workspaceKey = await generateWorkspaceKey();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const workspaceId = crypto.randomUUID();
    const inviteId = crypto.randomUUID();
    const sealed = await sealInviteWorkspaceKey(
      workspaceKey,
      secret,
      workspaceId,
      inviteId,
      1,
    );
    const unwrapped = await openInviteWorkspaceKey(
      sealed,
      secret,
      workspaceId,
      inviteId,
      1,
    );
    expect(await keyBytes(unwrapped)).toEqual(await keyBytes(workspaceKey));
    await expect(
      openInviteWorkspaceKey(
        sealed,
        crypto.getRandomValues(new Uint8Array(32)),
        workspaceId,
        inviteId,
        1,
      ),
    ).rejects.toThrow();
    await expect(
      openInviteWorkspaceKey(sealed, secret, crypto.randomUUID(), inviteId, 1),
    ).rejects.toThrow();
    await expect(
      openInviteWorkspaceKey(sealed, secret, workspaceId, inviteId, 2),
    ).rejects.toThrow();
  });
});
