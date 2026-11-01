import { describe, expect, it } from "vitest";
import {
  fingerprintPublicKey,
  generateIdentityKeyPair,
  generateWorkspaceKey,
  openInviteWorkspaceKey,
  openWorkspaceName,
  sealWorkspaceName,
  sealInviteWorkspaceKey,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
} from "./index.js";

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
