import { afterEach, describe, expect, it, vi } from "vitest";
import { generateWorkspaceKey } from "@zerocloud/shared";
import { createNearbyWorkspaceInvite, type WorkspaceView } from "./api";

describe("nearby workspace invite creation", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("returns the secret only to memory and sends only sealed invite material to the API", async () => {
    let postedBody = "";
    let postedUrl = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      postedUrl = String(input);
      postedBody = String(init?.body ?? "");
      const requestBody = JSON.parse(postedBody) as { inviteId: string; role: "editor" | "viewer"; keyVersion: number; wrappedKey: string };
      return new Response(JSON.stringify({ invite: { inviteId: requestBody.inviteId, workspaceId: "00000000-0000-4000-8000-000000000001", role: requestBody.role, keyVersion: requestBody.keyVersion, expiresAt: new Date(Date.now() + 60_000).toISOString(), wrappedKey: requestBody.wrappedKey } }), { status: 201, headers: { "content-type": "application/json" } });
    }));
    const workspace: WorkspaceView = { id: "00000000-0000-4000-8000-000000000001", name: "Private space", role: "owner", currentKeyVersion: 1, needsRotation: false, workspaceKey: await generateWorkspaceKey(), members: [] };
    const result = await createNearbyWorkspaceInvite("token", workspace, "viewer", "1h");
    expect(result.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect("link" in result).toBe(false);
    expect(postedUrl).not.toContain("#");
    expect(postedBody).not.toContain(result.secret);
    expect(postedBody).toContain("wrappedKey");
  });
});
