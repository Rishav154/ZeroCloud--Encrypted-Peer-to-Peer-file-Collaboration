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
import { getOrCreateIdentity } from "../identity/identityStore";
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
  workspaceKey: CryptoKey;
  members: WorkspaceMember[];
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
    const error = z
      .object({ error: z.object({ code: z.string(), message: z.string() }) })
      .safeParse(payload);
    throw new ApiError(
      error.success ? error.data.error.message : "Request failed",
      error.success ? error.data.error.code : "REQUEST_FAILED",
      response.status,
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
  const wrapper = members.find(
    (member) => member.userId === workspace.wrapperUserId,
  );
  if (!wrapper) {
    throw new ApiError(
      "Workspace key wrapper identity is missing",
      "KEY_UNAVAILABLE",
      409,
    );
  }
  const workspaceKey = await unwrapWorkspaceKey(
    workspace.wrappedKey,
    identity.privateKey,
    {
      wrapperPublicKeyRaw: base64ToBytes(wrapper.publicKey),
      recipientPublicKeyRaw: identity.publicKeyRaw,
      algorithm: sessionAlgorithm(user),
      workspaceId: workspace.id,
      keyVersion: workspace.currentKeyVersion,
      wrapperFingerprint: wrapper.fingerprint,
      recipientFingerprint: identity.fingerprint,
    },
  );
  const name = await openWorkspaceName(
    workspaceKey,
    workspace.id,
    workspace.nameSealed,
  );
  return {
    id: workspace.id,
    name,
    role: workspace.role,
    currentKeyVersion: workspace.currentKeyVersion,
    workspaceKey,
    members,
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
  workspaceId: string,
  userId: string,
): Promise<void> {
  await apiRequest(
    token,
    `/workspaces/${workspaceId}/members/${userId}`,
    z.object({ removed: z.literal(true) }),
    { method: "DELETE" },
  );
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
