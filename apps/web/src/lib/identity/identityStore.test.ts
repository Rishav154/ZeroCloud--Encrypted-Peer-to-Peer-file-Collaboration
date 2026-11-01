import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { generateIdentityKeyPair, fingerprintPublicKey } from "@zerocloud/shared";
import {
  confirmWorkspaceMemberKeyPinUpdate,
  pinWorkspaceMemberKey,
} from "./identityStore";

const workspaceId = "1b81ed69-7e3b-4f9d-a726-83f6572cb67b";
const userId = "c6b8f79d-9082-4f41-9d38-224f34d6b36b";

async function candidate(): Promise<{ workspaceId: string; userId: string; fingerprint: string; publicKey: string }> {
  const pair = await generateIdentityKeyPair();
  return {
    workspaceId,
    userId,
    fingerprint: await fingerprintPublicKey(pair.publicKeyRaw),
    publicKey: Buffer.from(pair.publicKeyRaw).toString("base64"),
  };
}

describe("workspace member key pins", () => {
  it("pins the first valid key, matches it later, and rejects an unconfirmed change", async () => {
    const first = await candidate();
    expect(await pinWorkspaceMemberKey(first)).toBe("pinned");
    expect(await pinWorkspaceMemberKey(first)).toBe("match");
    const replacement = await candidate();
    expect(await pinWorkspaceMemberKey(replacement)).toBe("mismatch");
    await confirmWorkspaceMemberKeyPinUpdate(replacement);
    expect(await pinWorkspaceMemberKey(replacement)).toBe("match");
  });

  it("rejects a directory fingerprint that does not match its public key", async () => {
    const value = await candidate();
    expect(await pinWorkspaceMemberKey({ ...value, fingerprint: "0".repeat(64) })).toBe("invalid");
  });
});
