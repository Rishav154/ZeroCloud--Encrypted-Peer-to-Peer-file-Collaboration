import {
  bytesToBase64,
  fingerprintPublicKey,
  type IdentityAlgorithm,
} from "@zerocloud/shared";
import { z } from "zod";
import {
  sessionUserSchema,
  type AuthSession,
  type SessionUser,
} from "./session";
import { getOrCreateIdentity } from "../identity/identityStore";

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";

const authResponseSchema = z.object({
  accessToken: z.string().min(1),
  user: sessionUserSchema,
});

export type LocalIdentity = {
  algorithm: IdentityAlgorithm;
  fingerprint: string;
  publicKeyBase64: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function loadLocalIdentity(): Promise<LocalIdentity> {
  const identity = await getOrCreateIdentity(
    process.env.NEXT_PUBLIC_FORCE_P256 === "true",
  );
  return {
    algorithm: identity.algorithm,
    fingerprint: await fingerprintPublicKey(identity.publicKeyRaw),
    publicKeyBase64: bytesToBase64(identity.publicKeyRaw),
  };
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${apiBase}${path}`, {
      ...init,
      headers: {
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

function authSession(
  token: string,
  user: SessionUser,
  localFingerprint: string,
): AuthSession {
  if (user.fingerprint !== localFingerprint) {
    throw new ApiError(
      "This account is bound to a different device identity",
      "IDENTITY_MISMATCH",
      409,
    );
  }
  return { accessToken: token, user };
}

export async function registerAccount(
  input: { email: string; password: string; displayName: string },
  identity: LocalIdentity,
): Promise<AuthSession> {
  const response = await request("/auth/register", authResponseSchema, {
    method: "POST",
    body: JSON.stringify({
      ...input,
      publicKey: identity.publicKeyBase64,
      keyAlg: identity.algorithm,
      fingerprint: identity.fingerprint,
    }),
  });
  return authSession(response.accessToken, response.user, identity.fingerprint);
}

export async function loginAccount(
  input: { email: string; password: string },
  identity: LocalIdentity,
): Promise<AuthSession> {
  const response = await request("/auth/login", authResponseSchema, {
    method: "POST",
    body: JSON.stringify(input),
  });
  return authSession(response.accessToken, response.user, identity.fingerprint);
}

export async function getCurrentUser(
  accessToken: string,
): Promise<SessionUser> {
  const response = await request("/me", z.object({ user: sessionUserSchema }), {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  return response.user;
}

