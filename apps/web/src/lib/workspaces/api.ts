import {
  base64ToBytes,
  bytesToBase64,
  generateWorkspaceKey,
  openInviteWorkspaceKey,
  openWorkspaceName,
  sealWorkspaceName,
  unwrapWorkspaceKey,
  wrapWorkspaceKey,
  sealInviteWorkspaceKey,
  type IdentityAlgorithm,
} from "@zerocloud/shared";
import { z } from "zod";
import { getOrCreateIdentity, loadVerifiedFingerprints, pinWorkspaceMemberKey, type PinResult } from "../identity/identityStore";
import { workspaceKeyring } from "./keyring";
import { ApiError } from "../auth/api";
import type { SessionUser } from "../auth/session";

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

const workspaceListSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.string().uuid(),
      nameSealed: z.string(),
      currentKeyVersion: z.number().int().positive(),
      role: z.enum(["owner", "editor", "viewer"]),
    }),
  ),
});

const workspaceDetailSchema = z.object({
  workspace: z.object({
    id: z.string().uuid(),
    nameSealed: z.string(),
    currentKeyVersion: z.number().int().positive(),
    needsRotation: z.boolean(),
    role: z.enum(["owner", "editor", "viewer"]),
    wrappedKey: z.string(),
    wrapperUserId: z.string().uuid(),
  }),
  members: z.array(
    z.object({
      userId: z.string().uuid(),
      displayName: z.string(),
      role: z.enum(["owner", "editor", "viewer"]),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      publicKey: z.string(),
      keyAlg: z.enum(["X25519", "P-256"]),
    }),
  ),
});

export type WorkspaceMember = z.infer<
  typeof workspaceDetailSchema
>["members"][number];
export type WorkspaceView = {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  currentKeyVersion: number;
  needsRotation: boolean;
  workspaceKey: CryptoKey;
  members: (WorkspaceMember & { pinStatus: PinResult; verified: boolean })[];
};

async function apiRequest<T>(
  token: string,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch {
    throw new ApiError(
      "Could not reach the ZeroCloud server",
      "NETWORK_ERROR",
      0,
    );
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const nested = z.object({ error: z.object({ code: z.string(), message: z.string() }) }).safeParse(payload);
    const direct = z.object({ code: z.string(), message: z.string() }).safeParse(payload);
    const error = nested.success ? nested.data.error : direct.success ? direct.data : null;
    throw new ApiError(
      error?.message ?? "Request failed",
      error?.code ?? "REQUEST_FAILED",
      response.status,
      payload,
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(
      "The server returned an invalid response",
      "INVALID_RESPONSE",
      response.status,
    );
  }
  return parsed.data;
}

function sessionAlgorithm(user: SessionUser): IdentityAlgorithm {
  return user.keyAlg;
}

export async function createWorkspace(
  token: string,
  user: SessionUser,
  name: string,
): Promise<string> {
  const identity = await getOrCreateIdentity(
    process.env.NEXT_PUBLIC_FORCE_P256 === "true",
  );
  if (identity.fingerprint !== user.fingerprint) {
    throw new ApiError(
      "This account is bound to a different device identity",
      "IDENTITY_MISMATCH",
      409,
    );
  }
  const workspaceId = crypto.randomUUID();
  const workspaceKey = await generateWorkspaceKey();
  const nameSealed = await sealWorkspaceName(workspaceKey, workspaceId, name);
  await workspaceKeyring.add(workspaceId, 1, workspaceKey);
  const wrappedKey = await wrapWorkspaceKey(workspaceKey, identity.privateKey, {
    wrapperPublicKeyRaw: identity.publicKeyRaw,
    recipientPublicKeyRaw: identity.publicKeyRaw,
    algorithm: sessionAlgorithm(user),
    workspaceId,
    keyVersion: 1,
    wrapperFingerprint: identity.fingerprint,
    recipientFingerprint: identity.fingerprint,
  });
  await apiRequest(
    token,
    "/workspaces",
    z.object({
      id: z.string().uuid(),
      role: z.literal("owner"),
      currentKeyVersion: z.literal(1),
    }),
    {
      method: "POST",
      body: JSON.stringify({ id: workspaceId, nameSealed, wrappedKey }),
    },
  );
  return workspaceId;
}

export async function listWorkspaces(
  token: string,
  user: SessionUser,
): Promise<WorkspaceView[]> {
  const { workspaces } = await apiRequest(
    token,
    "/workspaces",
    workspaceListSchema,
  );
  return Promise.all(
    workspaces.map((workspace) => loadWorkspace(token, user, workspace.id)),
  );
}

export async function loadWorkspace(
  token: string,
  user: SessionUser,
  workspaceId: string,
): Promise<WorkspaceView> {
  const identity = await getOrCreateIdentity(
    process.env.NEXT_PUBLIC_FORCE_P256 === "true",
  );
  if (identity.fingerprint !== user.fingerprint) {
    throw new ApiError(
      "This account is bound to a different device identity",
      "IDENTITY_MISMATCH",
      409,
    );
  }
  const { workspace, members } = await apiRequest(
    token,
    `/workspaces/${encodeURIComponent(workspaceId)}`,
    workspaceDetailSchema,
  );
  const verifiedFingerprints = await loadVerifiedFingerprints();
  const pins = await Promise.all(members.map(async (member) => ({
    ...member,
    verified: verifiedFingerprints.has(member.fingerprint),
    pinStatus: await pinWorkspaceMemberKey({
      workspaceId: workspace.id,
      userId: member.userId,
      fingerprint: member.fingerprint,
      publicKey: member.publicKey,
    }),
  })));
  const wrapper = pins.find((member) => member.userId === workspace.wrapperUserId);
  if (!wrapper) {
    throw new ApiError(
      "Workspace key wrapper identity is missing",
      "KEY_UNAVAILABLE",
      409,
    );
  }
  if (wrapper.keyAlg !== identity.algorithm) {
    throw new ApiError("Workspace key wrapper uses an identity algorithm this browser cannot unwrap", "KEY_ALGORITHM_MISMATCH", 409);
  }
  const workspaceKey = await unwrapWorkspaceKey(
    workspace.wrappedKey,
    identity.privateKey,
    {
      wrapperPublicKeyRaw: base64ToBytes(wrapper.publicKey),
      recipientPublicKeyRaw: identity.publicKeyRaw,
      algorithm: wrapper.keyAlg,
      workspaceId: workspace.id,
      keyVersion: workspace.currentKeyVersion,
      wrapperFingerprint: wrapper.fingerprint,
      recipientFingerprint: identity.fingerprint,
    },
  );
  const keys = await apiRequest(token, `/workspaces/${workspace.id}/keys`, z.object({
    workspaceId: z.string().uuid(),
    currentKeyVersion: z.number().int().positive(),
    nameSealed: z.string(),
    keys: z.array(z.object({
      keyVersion: z.number().int().positive(),
      wrappedKey: z.string(),
      wrapperUserId: z.string().uuid(),
      wrapperPublicKey: z.string(),
      wrapperFingerprint: z.string(),
      wrapperKeyAlg: z.enum(["X25519", "P-256"]),
    })),
  }));
  for (const entry of keys.keys) {
    const versionWrapper = pins.find((member) => member.userId === entry.wrapperUserId);
    if (!versionWrapper || versionWrapper.publicKey !== entry.wrapperPublicKey || versionWrapper.fingerprint !== entry.wrapperFingerprint || versionWrapper.keyAlg !== entry.wrapperKeyAlg) {
      throw new ApiError("Workspace key wrapper identity does not match its pinned directory key", "KEY_WRAPPER_MISMATCH", 409);
    }
    if (entry.wrapperKeyAlg !== identity.algorithm) {
      throw new ApiError("A historical workspace key uses an unsupported identity algorithm", "KEY_ALGORITHM_MISMATCH", 409);
    }
    const versionKey = entry.keyVersion === workspace.currentKeyVersion
      ? workspaceKey
      : await unwrapWorkspaceKey(entry.wrappedKey, identity.privateKey, {
          wrapperPublicKeyRaw: base64ToBytes(versionWrapper.publicKey),
          recipientPublicKeyRaw: identity.publicKeyRaw,
          algorithm: versionWrapper.keyAlg,
          workspaceId: workspace.id,
          keyVersion: entry.keyVersion,
          wrapperFingerprint: versionWrapper.fingerprint,
          recipientFingerprint: identity.fingerprint,
        });
    if (entry.keyVersion === workspace.currentKeyVersion && entry.wrappedKey !== workspace.wrappedKey) {
      throw new ApiError("Workspace key list is inconsistent", "INVALID_RESPONSE", 502);
    }
    await workspaceKeyring.add(workspace.id, entry.keyVersion, versionKey);
  }
  const name = await openWorkspaceName(
    workspaceKey,
    workspace.id,
    workspace.nameSealed,
    workspace.currentKeyVersion,
  );
  return {
    id: workspace.id,
    name,
    role: workspace.role,
    currentKeyVersion: workspace.currentKeyVersion,
    needsRotation: workspace.needsRotation,
    workspaceKey,
    members: pins,
  };
}

const inviteMetaSchema = z.object({
  invite: z.object({
    inviteId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    role: z.enum(["editor", "viewer"]),
    keyVersion: z.number().int().positive(),
    expiresAt: z.string(),
    wrappedKey: z.string(),
    nameSealed: z.string().optional(),
  }),
});

export type InviteRecord = {
  inviteId: string;
  role: "editor" | "viewer";
  keyVersion: number;
  expiresAt: string;
  wrappedKey: string;
};

export async function createWorkspaceInvite(
  token: string,
  workspace: WorkspaceView,
  role: "editor" | "viewer",
  expiresIn: "1h" | "24h" | "7d",
): Promise<{ link: string; invite: InviteRecord }> {
  const inviteId = crypto.randomUUID();
  const inviteSecret = crypto.getRandomValues(new Uint8Array(32));
  const wrappedKey = await sealInviteWorkspaceKey(
    workspace.workspaceKey,
    inviteSecret,
    workspace.id,
    inviteId,
    workspace.currentKeyVersion,
  );
  const { invite } = await apiRequest(
    token,
    `/workspaces/${workspace.id}/invites`,
    z.object({ invite: inviteMetaSchema.shape.invite }),
    {
      method: "POST",
      body: JSON.stringify({
        inviteId,
        role,
        wrappedKey,
        keyVersion: workspace.currentKeyVersion,
        expiresIn,
      }),
    },
  );
  const secretBase64 = bytesToBase64(inviteSecret)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return {
    link: `${process.env.NEXT_PUBLIC_WEB_ORIGIN ?? window.location.origin}/join/${inviteId}#${secretBase64}`,
    invite: {
      inviteId,
      role: invite.role,
      keyVersion: invite.keyVersion,
      expiresAt: invite.expiresAt,
      wrappedKey: invite.wrappedKey,
    },
  };
}

export async function listWorkspaceInvites(
  token: string,
  workspaceId: string,
): Promise<InviteRecord[]> {
  const response = await apiRequest(
    token,
    `/workspaces/${workspaceId}/invites`,
    z.object({
      invites: z.array(
        z.object({
          inviteId: z.string().uuid(),
          role: z.enum(["editor", "viewer"]),
          keyVersion: z.number().int(),
          expiresAt: z.string(),
          createdAt: z.string(),
          wrappedKey: z.string(),
        }),
      ),
    }),
  );
  return response.invites;
}

export async function revokeWorkspaceInvite(
  token: string,
  workspaceId: string,
  inviteId: string,
): Promise<void> {
  await apiRequest(
    token,
    `/workspaces/${workspaceId}/invites/${inviteId}`,
    z.object({ revoked: z.literal(true) }),
    { method: "DELETE" },
  );
}

export async function changeWorkspaceMemberRole(
  token: string,
  workspaceId: string,
  userId: string,
  role: "editor" | "viewer",
): Promise<void> {
  await apiRequest(
    token,
    `/workspaces/${workspaceId}/members/${userId}`,
    z.object({ userId: z.string().uuid(), role: z.enum(["editor", "viewer"]) }),
    { method: "PATCH", body: JSON.stringify({ role }) },
  );
}

export async function removeWorkspaceMember(
  token: string,
  user: SessionUser,
  workspace: WorkspaceView,
  userId: string,
  confirmRecipients: (workspace: WorkspaceView) => Promise<boolean>,
): Promise<void> {
  const identity = await getOrCreateIdentity(process.env.NEXT_PUBLIC_FORCE_P256 === "true");
  let latest = workspace;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const recipients = latest.members.filter((member) => member.userId !== userId);
    if (recipients.some((member) => member.pinStatus === "mismatch" || member.pinStatus === "invalid")) {
      throw new ApiError("A recipient key changed: possible server tampering", "MEMBER_KEY_CHANGED", 409);
    }
    if (!await confirmRecipients(latest)) throw new ApiError("Rotation cancelled", "ROTATION_CANCELLED", 0);
    const workspaceKey = await generateWorkspaceKey();
    const nextVersion = latest.currentKeyVersion + 1;
    const nameSealed = await sealWorkspaceName(workspaceKey, latest.id, latest.name, nextVersion);
    const wrappedKeys = await Promise.all(recipients.map(async (member) => {
      if (member.keyAlg !== identity.algorithm) throw new ApiError(`Cannot wrap the workspace key for ${member.displayName}: key algorithms differ`, "KEY_ALGORITHM_MISMATCH", 409);
      return { userId: member.userId, wrappedKey: await wrapWorkspaceKey(workspaceKey, identity.privateKey, {
        wrapperPublicKeyRaw: identity.publicKeyRaw,
        recipientPublicKeyRaw: base64ToBytes(member.publicKey),
        algorithm: identity.algorithm,
        workspaceId: latest.id,
        keyVersion: nextVersion,
        wrapperFingerprint: identity.fingerprint,
        recipientFingerprint: member.fingerprint,
      }) };
    }));
    try {
      const response = await apiRequest(token, `/workspaces/${latest.id}/members/${userId}`, z.object({ version: z.number().int(), needsRotation: z.literal(false) }), {
        method: "DELETE",
        body: JSON.stringify({ newVersion: nextVersion, nameSealed, wrappedKeys }),
      });
      await workspaceKeyring.add(latest.id, response.version, workspaceKey);
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "MEMBERS_CHANGED" || attempt === 2) throw error;
      latest = await loadWorkspace(token, user, latest.id);
    }
  }
}

export async function rotateWorkspaceKey(
  token: string,
  user: SessionUser,
  workspace: WorkspaceView,
  confirmRecipients: (workspace: WorkspaceView) => Promise<boolean>,
): Promise<void> {
  const identity = await getOrCreateIdentity(process.env.NEXT_PUBLIC_FORCE_P256 === "true");
  let latest = workspace;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (latest.members.some((member) => member.pinStatus === "mismatch" || member.pinStatus === "invalid")) throw new ApiError("A member key changed: possible server tampering", "MEMBER_KEY_CHANGED", 409);
    if (!await confirmRecipients(latest)) throw new ApiError("Rotation cancelled", "ROTATION_CANCELLED", 0);
    const nextVersion = latest.currentKeyVersion + 1;
    const workspaceKey = await generateWorkspaceKey();
    const nameSealed = await sealWorkspaceName(workspaceKey, latest.id, latest.name, nextVersion);
    const wrappedKeys = await Promise.all(latest.members.map(async (member) => {
      if (member.keyAlg !== identity.algorithm) throw new ApiError(`Cannot wrap the workspace key for ${member.displayName}: key algorithms differ`, "KEY_ALGORITHM_MISMATCH", 409);
      return { userId: member.userId, wrappedKey: await wrapWorkspaceKey(workspaceKey, identity.privateKey, {
        wrapperPublicKeyRaw: identity.publicKeyRaw,
        recipientPublicKeyRaw: base64ToBytes(member.publicKey),
        algorithm: identity.algorithm,
        workspaceId: latest.id,
        keyVersion: nextVersion,
        wrapperFingerprint: identity.fingerprint,
        recipientFingerprint: member.fingerprint,
      }) };
    }));
    try {
      const response = await apiRequest(token, `/workspaces/${latest.id}/rotate`, z.object({ version: z.number().int(), needsRotation: z.literal(false) }), {
        method: "POST",
        body: JSON.stringify({ newVersion: nextVersion, nameSealed, wrappedKeys }),
      });
      await workspaceKeyring.add(latest.id, response.version, workspaceKey);
      return;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "MEMBERS_CHANGED" || attempt === 2) throw error;
      latest = await loadWorkspace(token, user, latest.id);
    }
  }
}

export async function leaveWorkspace(token: string, workspaceId: string): Promise<void> {
  await apiRequest(token, `/workspaces/${workspaceId}/leave`, z.object({ left: z.literal(true), needsRotation: z.literal(true) }), { method: "POST" });
  workspaceKeyring.clearWorkspace(workspaceId);
}

export async function fetchInvite(
  token: string,
  inviteId: string,
): Promise<z.infer<typeof inviteMetaSchema>["invite"]> {
  const result = await apiRequest(
    token,
    `/invites/${inviteId}`,
    inviteMetaSchema,
  );
  return result.invite;
}

export async function acceptInvite(
  token: string,
  user: SessionUser,
  invite: z.infer<typeof inviteMetaSchema>["invite"],
  secretBase64Url: string,
): Promise<void> {
  const identity = await getOrCreateIdentity(
    process.env.NEXT_PUBLIC_FORCE_P256 === "true",
  );
  if (identity.fingerprint !== user.fingerprint)
    throw new ApiError(
      "This account is bound to a different device identity",
      "IDENTITY_MISMATCH",
      409,
    );
  const normalizedSecret = secretBase64Url
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const secretBytes = base64ToBytes(
    normalizedSecret + "=".repeat((4 - (normalizedSecret.length % 4)) % 4),
  );
  if (secretBytes.length !== 32)
    throw new ApiError(
      "Invite link is missing a valid secret",
      "INVALID_INVITE",
      400,
    );
  const workspaceKey = await openInviteWorkspaceKey(
    invite.wrappedKey,
    secretBytes,
    invite.workspaceId,
    invite.inviteId,
    invite.keyVersion,
  );
  await workspaceKeyring.add(invite.workspaceId, invite.keyVersion, workspaceKey);
  const wrappedForSelf = await wrapWorkspaceKey(
    workspaceKey,
    identity.privateKey,
    {
      wrapperPublicKeyRaw: identity.publicKeyRaw,
      recipientPublicKeyRaw: identity.publicKeyRaw,
      algorithm: sessionAlgorithm(user),
      workspaceId: invite.workspaceId,
      keyVersion: invite.keyVersion,
      wrapperFingerprint: identity.fingerprint,
      recipientFingerprint: identity.fingerprint,
    },
  );
  await apiRequest(
    token,
    `/invites/${invite.inviteId}/accept`,
    z.object({
      workspaceId: z.string().uuid(),
      role: z.enum(["editor", "viewer"]),
    }),
    { method: "POST", body: JSON.stringify({ wrappedForSelf }) },
  );
}
