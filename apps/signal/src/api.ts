import argon2 from "argon2";
import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import rateLimit from "express-rate-limit";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { requireSession, createSessionToken } from "./auth/session.js";
import type { WorkspaceHub } from "./workspaceHub.js";
import { loginBodySchema, registerBodySchema } from "./auth/schemas.js";
import {
  acceptInviteBodySchema,
  createInviteBodySchema,
  createWorkspaceBodySchema,
  rotateWorkspaceBodySchema,
  removeMemberWithRotationBodySchema,
  updateMemberRoleBodySchema,
  workspaceIdSchema,
} from "./workspaces/schemas.js";
import type { WorkspaceMemberDirectory } from "@zerocloud/shared";

export type ApiConfig = {
  JWT_SECRET: string;
};

function errorResponse(
  response: Response,
  status: number,
  code: string,
  message: string,
): void {
  response.status(status).json({ error: { code, message } });
}

function authenticatedUserId(response: Response): string {
  const userId = (response.locals as { authUserId?: unknown }).authUserId;
  if (typeof userId !== "string")
    throw new Error("Authenticated user is missing");
  return userId;
}

function validatedBody<T extends z.ZodType>(
  schema: T,
  request: Request,
  response: Response,
): z.infer<T> | null {
  const parsed = schema.safeParse(request.body);
  if (parsed.success) return parsed.data;
  errorResponse(response, 400, "INVALID_REQUEST", "Request body is invalid");
  return null;
}

function getRawPublicKey(
  encoded: string,
  algorithm: "X25519" | "P-256",
): Buffer | null {
  try {
    const key = Buffer.from(encoded, "base64");
    const expectedLength = algorithm === "X25519" ? 32 : 65;
    if (key.length !== expectedLength || key.toString("base64") !== encoded) {
      return null;
    }
    return key;
  } catch {
    return null;
  }
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function uniqueViolation(error: unknown): string | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    typeof error.constraint === "string"
  ) {
    return error.constraint;
  }
  return null;
}

function failureHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  void _next;
  if (error instanceof z.ZodError) {
    errorResponse(response, 400, "INVALID_REQUEST", "Request is invalid");
    return;
  }
  errorResponse(
    response,
    500,
    "INTERNAL_ERROR",
    "The request could not be completed",
  );
}

export function createApiRouter(
  pool: Pool,
  config: ApiConfig,
  workspaceHub?: WorkspaceHub,
): Router {
  const router = Router();
  const session = requireSession(config.JWT_SECRET);
  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_request, response) => {
      errorResponse(
        response,
        429,
        "RATE_LIMITED",
        "Too many authentication attempts",
      );
    },
  });

  const authRouter = Router();
  authRouter.use(authLimiter);

  type RotationMember = {
    user_id: string;
    display_name: string;
    role: "owner" | "editor" | "viewer";
    fingerprint: string;
    public_key: Buffer;
    key_alg: "X25519" | "P-256";
  };
  type RotationOutcome =
    | { kind: "ok"; version: number }
    | { kind: "members-changed"; members: RotationMember[] }
    | { kind: "error"; status: number; code: string; message: string };

  async function rotateWorkspace(
    workspaceId: string,
    actorId: string,
    body: z.infer<typeof rotateWorkspaceBodySchema>,
    removeUserId: string | undefined,
  ): Promise<RotationOutcome> {
    const client = await pool.connect();
    let committedVersion: number | null = null;
    try {
      await client.query("BEGIN");
      const locked = await client.query<{
        current_key_version: number;
        owner_id: string;
        role: string | null;
      }>(
        `SELECT w.current_key_version, w.owner_id, m.role
         FROM workspaces w
         LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2
         WHERE w.id = $1
         FOR UPDATE OF w`,
        [workspaceId, actorId],
      );
      const workspace = locked.rows[0];
      if (!workspace || !workspace.role) {
        await client.query("ROLLBACK");
        return {
          kind: "error",
          status: 404,
          code: "NOT_FOUND",
          message: "Workspace not found",
        };
      }
      if (workspace.role !== "owner") {
        await client.query("ROLLBACK");
        return {
          kind: "error",
          status: 403,
          code: "FORBIDDEN",
          message: "Only the workspace owner can rotate the key",
        };
      }
      if (removeUserId === workspace.owner_id) {
        await client.query("ROLLBACK");
        return {
          kind: "error",
          status: 409,
          code: "OWNER_CANNOT_BE_REMOVED",
          message: "The workspace owner cannot be removed",
        };
      }
      if (body.newVersion !== workspace.current_key_version + 1) {
        await client.query("ROLLBACK");
        return {
          kind: "error",
          status: 409,
          code: "KEY_VERSION_MISMATCH",
          message: "The new key version must increment the current version",
        };
      }
      const currentMembers = await client.query<RotationMember>(
        `SELECT u.id AS user_id, u.display_name, m.role, u.fingerprint,
                u.public_key, u.key_alg
         FROM workspace_members m JOIN users u ON u.id = m.user_id
         WHERE m.workspace_id = $1
         ORDER BY m.joined_at, u.display_name`,
        [workspaceId],
      );
      const members = currentMembers.rows;
      if (
        removeUserId &&
        !members.some((member) => member.user_id === removeUserId)
      ) {
        await client.query("ROLLBACK");
        return {
          kind: "error",
          status: 404,
          code: "NOT_FOUND",
          message: "Workspace member not found",
        };
      }
      const expectedIds = members
        .filter((member) => member.user_id !== removeUserId)
        .map((member) => member.user_id);
      const actualIds = body.wrappedKeys.map((entry) => entry.userId);
      const actualSet = new Set(actualIds);
      if (
        actualIds.length !== expectedIds.length ||
        actualSet.size !== actualIds.length ||
        expectedIds.some((id) => !actualSet.has(id))
      ) {
        await client.query("ROLLBACK");
        return { kind: "members-changed", members };
      }

      if (removeUserId) {
        await client.query(
          "DELETE FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2",
          [workspaceId, removeUserId],
        );
        await client.query(
          "DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
          [workspaceId, removeUserId],
        );
      }
      for (const wrapped of body.wrappedKeys) {
        await client.query(
          `INSERT INTO workspace_keys
             (workspace_id, user_id, key_version, wrapped_key, wrapper_user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [workspaceId, wrapped.userId, body.newVersion, wrapped.wrappedKey, actorId],
        );
      }
      await client.query(
        `UPDATE workspaces
         SET current_key_version = $2, name_sealed = $3, needs_rotation = false
         WHERE id = $1`,
        [workspaceId, body.newVersion, body.nameSealed],
      );
      await client.query(
        `UPDATE invites SET revoked_at = now()
         WHERE workspace_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
        [workspaceId],
      );
      await client.query("COMMIT");
      committedVersion = body.newVersion;
      return { kind: "ok", version: committedVersion };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  function sendRotationOutcome(
    response: Response,
    outcome: RotationOutcome,
    workspaceId: string,
    removeUserId?: string,
  ): void {
    if (outcome.kind === "error") {
      errorResponse(response, outcome.status, outcome.code, outcome.message);
      return;
    }
    if (outcome.kind === "members-changed") {
      response.status(409).json({
        code: "MEMBERS_CHANGED",
        message: "The workspace membership changed during key rotation",
        members: outcome.members.map((member) => ({
          userId: member.user_id,
          displayName: member.display_name,
          role: member.role,
          fingerprint: member.fingerprint,
          publicKey: member.public_key.toString("base64"),
          keyAlg: member.key_alg,
        })),
      });
      return;
    }
    workspaceHub?.keyRotated(workspaceId, outcome.version);
    if (removeUserId) workspaceHub?.removeMember(workspaceId, removeUserId);
    response.json({ version: outcome.version, needsRotation: false });
  }

  authRouter.post("/register", async (request, response) => {
    const body = validatedBody(registerBodySchema, request, response);
    if (!body) return;
    const publicKey = getRawPublicKey(body.publicKey, body.keyAlg);
    if (!publicKey) {
      errorResponse(
        response,
        400,
        "INVALID_PUBLIC_KEY",
        "Public key is invalid for this algorithm",
      );
      return;
    }
    const fingerprint = createHash("sha256").update(publicKey).digest("hex");
    if (fingerprint !== body.fingerprint) {
      errorResponse(
        response,
        400,
        "FINGERPRINT_MISMATCH",
        "Fingerprint does not match the public key",
      );
      return;
    }
    const userId = randomUUID();
    const passwordHash = await argon2.hash(body.password, {
      type: argon2.argon2id,
    });
    try {
      await pool.query(
        `INSERT INTO users (id, email, display_name, password_hash, public_key, key_alg, fingerprint)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          userId,
          normalizedEmail(body.email),
          body.displayName,
          passwordHash,
          publicKey,
          body.keyAlg,
          fingerprint,
        ],
      );
    } catch (error) {
      const constraint = uniqueViolation(error);
      if (constraint === "users_email_key") {
        errorResponse(
          response,
          409,
          "EMAIL_EXISTS",
          "An account with this email already exists",
        );
        return;
      }
      if (constraint === "users_fingerprint_key") {
        errorResponse(
          response,
          409,
          "IDENTITY_ALREADY_BOUND",
          "This browser identity is already bound to an account",
        );
        return;
      }
      throw error;
    }
    const accessToken = await createSessionToken(userId, config.JWT_SECRET);
    response.status(201).json({
      accessToken,
      user: {
        id: userId,
        email: normalizedEmail(body.email),
        displayName: body.displayName,
        fingerprint,
        keyAlg: body.keyAlg,
      },
    });
  });

  authRouter.post("/login", async (request, response) => {
    const body = validatedBody(loginBodySchema, request, response);
    if (!body) return;
    const result = await pool.query<{
      id: string;
      email: string;
      display_name: string;
      password_hash: string;
      fingerprint: string;
      key_alg: "X25519" | "P-256";
    }>(
      `SELECT id, email, display_name, password_hash, fingerprint, key_alg
       FROM users WHERE email = $1`,
      [normalizedEmail(body.email)],
    );
    const user = result.rows[0];
    const valid = user
      ? await argon2.verify(user.password_hash, body.password)
      : false;
    if (!user || !valid) {
      errorResponse(
        response,
        401,
        "INVALID_CREDENTIALS",
        "Invalid credentials",
      );
      return;
    }
    const accessToken = await createSessionToken(user.id, config.JWT_SECRET);
    response.json({
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        fingerprint: user.fingerprint,
        keyAlg: user.key_alg,
      },
    });
  });

  router.use("/auth", authRouter);
  router.use(session);

  router.get("/me", async (request, response) => {
    const result = await pool.query<{
      id: string;
      email: string;
      display_name: string;
      fingerprint: string;
      key_alg: "X25519" | "P-256";
    }>(
      "SELECT id, email, display_name, fingerprint, key_alg FROM users WHERE id = $1",
      [authenticatedUserId(response)],
    );
    const user = result.rows[0];
    if (!user) {
      errorResponse(
        response,
        401,
        "UNAUTHORIZED",
        "Invalid or expired session",
      );
      return;
    }
    response.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        fingerprint: user.fingerprint,
        keyAlg: user.key_alg,
      },
    });
  });

  router.post("/workspaces", async (request, response) => {
    const body = validatedBody(createWorkspaceBodySchema, request, response);
    if (!body) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO workspaces (id, name_sealed, owner_id) VALUES ($1, $2, $3)`,
        [body.id, body.nameSealed, authenticatedUserId(response)],
      );
      await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
        [body.id, authenticatedUserId(response)],
      );
      await client.query(
        `INSERT INTO workspace_keys (workspace_id, user_id, key_version, wrapped_key, wrapper_user_id)
         VALUES ($1, $2, 1, $3, $2)`,
        [body.id, authenticatedUserId(response), body.wrappedKey],
      );
      await client.query("COMMIT");
      response
        .status(201)
        .json({ id: body.id, role: "owner", currentKeyVersion: 1 });
    } catch (error) {
      await client.query("ROLLBACK");
      if (uniqueViolation(error) === "workspaces_pkey") {
        errorResponse(
          response,
          409,
          "WORKSPACE_EXISTS",
          "A workspace with this ID already exists",
        );
        return;
      }
      throw error;
    } finally {
      client.release();
    }
  });

  router.get("/workspaces", async (request, response) => {
    const result = await pool.query(
      `SELECT w.id, w.name_sealed, w.current_key_version, w.needs_rotation, m.role
       FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id
       WHERE m.user_id = $1 ORDER BY w.created_at DESC`,
      [authenticatedUserId(response)],
    );
    response.json({
      workspaces: result.rows.map((row) => ({
        id: row.id,
        nameSealed: row.name_sealed,
        currentKeyVersion: row.current_key_version,
        needsRotation: row.needs_rotation,
        role: row.role,
      })),
    });
  });

  router.get("/workspaces/:id", async (request, response) => {
    const parsedId = workspaceIdSchema.safeParse(request.params.id);
    if (!parsedId.success) {
      errorResponse(
        response,
        400,
        "INVALID_REQUEST",
        "Workspace ID is invalid",
      );
      return;
    }
    const workspaceResult = await pool.query<{
      id: string;
      name_sealed: string;
      current_key_version: number;
      needs_rotation: boolean;
      role: string;
      wrapped_key: string | null;
      wrapper_user_id: string | null;
    }>(
      `SELECT w.id, w.name_sealed, w.current_key_version, w.needs_rotation, m.role, k.wrapped_key, k.wrapper_user_id
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2
       LEFT JOIN workspace_keys k ON k.workspace_id = w.id AND k.user_id = m.user_id AND k.key_version = w.current_key_version
       WHERE w.id = $1`,
      [parsedId.data, authenticatedUserId(response)],
    );
    const workspace = workspaceResult.rows[0];
    if (!workspace) {
      errorResponse(response, 404, "NOT_FOUND", "Workspace not found");
      return;
    }
    if (!workspace.wrapped_key || !workspace.wrapper_user_id) {
      errorResponse(
        response,
        409,
        "KEY_UNAVAILABLE",
        "Workspace key is unavailable for this member",
      );
      return;
    }
    const membersResult = await pool.query<{
      id: string;
      display_name: string;
      role: string;
      fingerprint: string;
      public_key: Buffer;
      key_alg: "X25519" | "P-256";
    }>(
      `SELECT u.id, u.display_name, m.role, u.fingerprint, u.public_key, u.key_alg
       FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 ORDER BY m.joined_at, u.display_name`,
      [parsedId.data],
    );
    response.json({
      workspace: {
        id: workspace.id,
        nameSealed: workspace.name_sealed,
        currentKeyVersion: workspace.current_key_version,
        needsRotation: workspace.needs_rotation,
        role: workspace.role,
        wrappedKey: workspace.wrapped_key,
        wrapperUserId: workspace.wrapper_user_id,
      },
      members: membersResult.rows.map((member) => ({
        userId: member.id,
        displayName: member.display_name,
        role: member.role,
        fingerprint: member.fingerprint,
        publicKey: member.public_key.toString("base64"),
        keyAlg: member.key_alg,
      })),
    });
  });

  router.get("/workspaces/:id/keys", async (request, response) => {
    const workspaceId = workspaceIdSchema.safeParse(request.params.id);
    if (!workspaceId.success) {
      errorResponse(response, 400, "INVALID_REQUEST", "Workspace ID is invalid");
      return;
    }
    const userId = authenticatedUserId(response);
    const result = await pool.query<{
      current_key_version: number;
      name_sealed: string;
      key_version: number;
      wrapped_key: string;
      wrapper_user_id: string;
      wrapper_public_key: Buffer;
      wrapper_fingerprint: string;
      wrapper_key_alg: "X25519" | "P-256";
    }>(
      `SELECT w.current_key_version, w.name_sealed, k.key_version, k.wrapped_key,
              k.wrapper_user_id, u.public_key AS wrapper_public_key,
              u.fingerprint AS wrapper_fingerprint, u.key_alg AS wrapper_key_alg
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2
       JOIN workspace_keys k ON k.workspace_id = w.id AND k.user_id = $2
       JOIN users u ON u.id = k.wrapper_user_id
       WHERE w.id = $1 ORDER BY k.key_version`,
      [workspaceId.data, userId],
    );
    if (result.rowCount === 0) {
      const member = await pool.query(
        "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId.data, userId],
      );
      if (!member.rowCount) {
        errorResponse(response, 404, "NOT_FOUND", "Workspace not found");
        return;
      }
      errorResponse(response, 409, "KEY_UNAVAILABLE", "Workspace keys are unavailable");
      return;
    }
    const first = result.rows[0];
    if (!first) {
      errorResponse(response, 409, "KEY_UNAVAILABLE", "Workspace keys are unavailable");
      return;
    }
    response.json({
      workspaceId: workspaceId.data,
      currentKeyVersion: first.current_key_version,
      nameSealed: first.name_sealed,
      keys: result.rows.map((row) => ({
        keyVersion: row.key_version,
        wrappedKey: row.wrapped_key,
        wrapperUserId: row.wrapper_user_id,
        wrapperPublicKey: row.wrapper_public_key.toString("base64"),
        wrapperFingerprint: row.wrapper_fingerprint,
        wrapperKeyAlg: row.wrapper_key_alg,
      })),
    });
  });

  router.post("/workspaces/:id/rotate", async (request, response) => {
    const workspaceId = workspaceIdSchema.safeParse(request.params.id);
    const body = validatedBody(rotateWorkspaceBodySchema, request, response);
    if (!workspaceId.success) {
      errorResponse(response, 400, "INVALID_REQUEST", "Workspace ID is invalid");
      return;
    }
    if (!body) return;
    const outcome = await rotateWorkspace(
      workspaceId.data,
      authenticatedUserId(response),
      body,
      body.removeUserId,
    );
    sendRotationOutcome(response, outcome, workspaceId.data, body.removeUserId);
  });

  router.post("/workspaces/:id/invites", async (request, response) => {
    const parsedId = workspaceIdSchema.safeParse(request.params.id);
    const body = validatedBody(createInviteBodySchema, request, response);
    if (!parsedId.success) {
      errorResponse(
        response,
        400,
        "INVALID_REQUEST",
        "Workspace ID is invalid",
      );
      return;
    }
    if (!body) return;
    const userId = authenticatedUserId(response);
    const expiresAt = new Date(
      Date.now() +
        { "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000 }[
          body.expiresIn
        ],
    );
    const inviteClient = await pool.connect();
    try {
      await inviteClient.query("BEGIN");
      const locked = await inviteClient.query<{ role: string; current_key_version: number }>(
        `SELECT m.role, w.current_key_version FROM workspaces w
         LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2
         WHERE w.id = $1 FOR UPDATE OF w`,
        [parsedId.data, userId],
      );
      const record = locked.rows[0];
      if (!record) {
        await inviteClient.query("ROLLBACK");
        errorResponse(response, 404, "NOT_FOUND", "Workspace not found");
        return;
      }
      if (record.role !== "owner") {
        await inviteClient.query("ROLLBACK");
        errorResponse(response, record.role ? 403 : 404, record.role ? "FORBIDDEN" : "NOT_FOUND", record.role ? "Only the workspace owner can create invites" : "Workspace not found");
        return;
      }
      if (record.current_key_version !== body.keyVersion) {
        await inviteClient.query("ROLLBACK");
        errorResponse(response, 409, "KEY_VERSION_MISMATCH", "Invite key version is no longer current");
        return;
      }
      await inviteClient.query(
        `INSERT INTO invites (id, workspace_id, created_by, role, wrapped_key, key_version, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [body.inviteId, parsedId.data, userId, body.role, body.wrappedKey, body.keyVersion, expiresAt],
      );
      await inviteClient.query("COMMIT");
    } catch (error) {
      await inviteClient.query("ROLLBACK");
      throw error;
    } finally {
      inviteClient.release();
    }
    response.status(201).json({
      invite: {
        inviteId: body.inviteId,
        workspaceId: parsedId.data,
        role: body.role,
        keyVersion: body.keyVersion,
        expiresAt: expiresAt.toISOString(),
        wrappedKey: body.wrappedKey,
      },
    });
  });

  router.get("/workspaces/:id/invites", async (request, response) => {
    const parsedId = workspaceIdSchema.safeParse(request.params.id);
    if (!parsedId.success) {
      errorResponse(
        response,
        400,
        "INVALID_REQUEST",
        "Workspace ID is invalid",
      );
      return;
    }
    const userId = authenticatedUserId(response);
    const membership = await pool.query<{ role: string }>(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [parsedId.data, userId],
    );
    if (!membership.rows[0]) {
      errorResponse(response, 404, "NOT_FOUND", "Workspace not found");
      return;
    }
    if (membership.rows[0].role !== "owner") {
      errorResponse(
        response,
        403,
        "FORBIDDEN",
        "Only the workspace owner can list invites",
      );
      return;
    }
    const invites = await pool.query<{
      id: string;
      role: "editor" | "viewer";
      wrapped_key: string;
      key_version: number;
      expires_at: Date;
      created_at: Date;
    }>(
      `SELECT id, role, wrapped_key, key_version, expires_at, created_at
       FROM invites
       WHERE workspace_id = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC`,
      [parsedId.data],
    );
    response.json({
      invites: invites.rows.map((invite) => ({
        inviteId: invite.id,
        role: invite.role,
        wrappedKey: invite.wrapped_key,
        keyVersion: invite.key_version,
        expiresAt: invite.expires_at.toISOString(),
        createdAt: invite.created_at.toISOString(),
      })),
    });
  });

  router.delete(
    "/workspaces/:id/invites/:inviteId",
    async (request, response) => {
      const workspaceId = workspaceIdSchema.safeParse(request.params.id);
      const inviteId = workspaceIdSchema.safeParse(request.params.inviteId);
      if (!workspaceId.success || !inviteId.success) {
        errorResponse(
          response,
          400,
          "INVALID_REQUEST",
          "Workspace or invite ID is invalid",
        );
        return;
      }
      const userId = authenticatedUserId(response);
      const membership = await pool.query<{ role: string }>(
        "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId.data, userId],
      );
      if (!membership.rows[0]) {
        errorResponse(response, 404, "NOT_FOUND", "Workspace not found");
        return;
      }
      if (membership.rows[0].role !== "owner") {
        errorResponse(
          response,
          403,
          "FORBIDDEN",
          "Only the workspace owner can revoke invites",
        );
        return;
      }
      const revoked = await pool.query(
        `UPDATE invites SET revoked_at = now()
       WHERE id = $1 AND workspace_id = $2 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
       RETURNING id`,
        [inviteId.data, workspaceId.data],
      );
      if (!revoked.rowCount) {
        errorResponse(response, 404, "NOT_FOUND", "Pending invite not found");
        return;
      }
      response.json({ revoked: true });
    },
  );

  router.get("/invites/:inviteId", async (request, response) => {
    const inviteId = workspaceIdSchema.safeParse(request.params.inviteId);
    if (!inviteId.success) {
      errorResponse(response, 400, "INVALID_REQUEST", "Invite ID is invalid");
      return;
    }
    const invite = await pool.query<{
      workspace_id: string;
      role: "editor" | "viewer";
      wrapped_key: string;
      key_version: number;
      expires_at: Date;
      name_sealed: string;
    }>(
      `SELECT i.workspace_id, i.role, i.wrapped_key, i.key_version, i.expires_at, w.name_sealed
       FROM invites i JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.id = $1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [inviteId.data],
    );
    const record = invite.rows[0];
    if (!record) {
      errorResponse(response, 404, "NOT_FOUND", "Invite is invalid or expired");
      return;
    }
    response.json({
      invite: {
        inviteId: inviteId.data,
        workspaceId: record.workspace_id,
        role: record.role,
        wrappedKey: record.wrapped_key,
        keyVersion: record.key_version,
        expiresAt: record.expires_at.toISOString(),
        nameSealed: record.name_sealed,
      },
    });
  });

  router.post("/invites/:inviteId/accept", async (request, response) => {
    const inviteId = workspaceIdSchema.safeParse(request.params.inviteId);
    const body = validatedBody(acceptInviteBodySchema, request, response);
    if (!inviteId.success) {
      errorResponse(response, 400, "INVALID_REQUEST", "Invite ID is invalid");
      return;
    }
    if (!body) return;
    const userId = authenticatedUserId(response);
    const client = await pool.connect();
    let workspaceId = "";
    let acceptedRole: "editor" | "viewer" = "viewer";
    try {
      await client.query("BEGIN");
      const inviteWorkspace = await client.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM invites WHERE id = $1",
        [inviteId.data],
      );
      if (!inviteWorkspace.rows[0]) {
        await client.query("ROLLBACK");
        errorResponse(response, 404, "NOT_FOUND", "Invite is invalid or expired");
        return;
      }
      const lockedWorkspace = await client.query<{ current_key_version: number }>(
        "SELECT current_key_version FROM workspaces WHERE id = $1 FOR UPDATE",
        [inviteWorkspace.rows[0].workspace_id],
      );
      const currentVersion = lockedWorkspace.rows[0]?.current_key_version;
      const lockedInvite = await client.query<{
        workspace_id: string;
        role: "editor" | "viewer";
        key_version: number;
        expired: boolean;
        used_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT workspace_id, role, key_version, expires_at <= now() AS expired, used_at, revoked_at
         FROM invites WHERE id = $1 FOR UPDATE`,
        [inviteId.data],
      );
      const invite = lockedInvite.rows[0];
      if (!invite || invite.expired || invite.used_at || invite.revoked_at) {
        await client.query("ROLLBACK");
        errorResponse(
          response,
          404,
          "NOT_FOUND",
          "Invite is invalid or expired",
        );
        return;
      }
      workspaceId = invite.workspace_id;
      if (invite.key_version !== currentVersion) {
        await client.query("ROLLBACK");
        errorResponse(response, 409, "STALE_INVITE_VERSION", "This invite uses an outdated workspace key");
        return;
      }
      acceptedRole = invite.role;
      const existingMember = await client.query(
        "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId, userId],
      );
      if (existingMember.rowCount) {
        await client.query("ROLLBACK");
        errorResponse(
          response,
          409,
          "ALREADY_A_MEMBER",
          "You are already a workspace member",
        );
        return;
      }
      await client.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)",
        [workspaceId, userId, invite.role],
      );
      await client.query(
        `INSERT INTO workspace_keys (workspace_id, user_id, key_version, wrapped_key, wrapper_user_id)
         VALUES ($1, $2, $3, $4, $2)`,
        [workspaceId, userId, invite.key_version, body.wrappedForSelf],
      );
      await client.query(
        "UPDATE invites SET used_by = $2, used_at = now() WHERE id = $1",
        [inviteId.data, userId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (uniqueViolation(error) === "workspace_members_pkey") {
        errorResponse(
          response,
          409,
          "ALREADY_A_MEMBER",
          "You are already a workspace member",
        );
        return;
      }
      throw error;
    } finally {
      client.release();
    }
    const memberResult = await pool.query<{
      user_id: string;
      display_name: string;
      role: "owner" | "editor" | "viewer";
      fingerprint: string;
      public_key: Buffer;
    }>(
      `SELECT u.id AS user_id, u.display_name, m.role, u.fingerprint, u.public_key
       FROM workspace_members m JOIN users u ON u.id = m.user_id
       WHERE m.workspace_id = $1 AND m.user_id = $2`,
      [workspaceId, userId],
    );
    const memberRecord = memberResult.rows[0];
    if (memberRecord) {
      const member: WorkspaceMemberDirectory = {
        userId: memberRecord.user_id,
        displayName: memberRecord.display_name,
        role: memberRecord.role,
        fingerprint: memberRecord.fingerprint,
        publicKey: memberRecord.public_key.toString("base64"),
      };
      workspaceHub?.memberAdded(workspaceId, member);
    }
    response.status(200).json({ workspaceId, role: acceptedRole });
  });

  router.patch("/workspaces/:id/members/:userId", async (request, response) => {
    const workspaceId = workspaceIdSchema.safeParse(request.params.id);
    const targetUserId = workspaceIdSchema.safeParse(request.params.userId);
    const body = validatedBody(updateMemberRoleBodySchema, request, response);
    if (!workspaceId.success || !targetUserId.success) {
      errorResponse(
        response,
        400,
        "INVALID_REQUEST",
        "Workspace or user ID is invalid",
      );
      return;
    }
    if (!body) return;
    const userId = authenticatedUserId(response);
    const owner = await pool.query<{ role: string }>(
      "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId.data, userId],
    );
    if (!owner.rows[0]) {
      errorResponse(response, 404, "NOT_FOUND", "Workspace not found");
      return;
    }
    if (owner.rows[0].role !== "owner") {
      errorResponse(
        response,
        403,
        "FORBIDDEN",
        "Only the workspace owner can change roles",
      );
      return;
    }
    const changed = await pool.query<{ role: string }>(
      `UPDATE workspace_members SET role = $3
       WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner'
       RETURNING role`,
      [workspaceId.data, targetUserId.data, body.role],
    );
    if (!changed.rowCount) {
      const target = await pool.query(
        "SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
        [workspaceId.data, targetUserId.data],
      );
      if (target.rowCount) {
        errorResponse(
          response,
          409,
          "OWNER_ROLE_IMMUTABLE",
          "The owner role cannot be changed",
        );
      } else {
        errorResponse(response, 404, "NOT_FOUND", "Workspace member not found");
      }
      return;
    }
    workspaceHub?.roleChanged(workspaceId.data, targetUserId.data, body.role);
    response.json({ userId: targetUserId.data, role: body.role });
  });

  router.delete(
    "/workspaces/:id/members/:userId",
    async (request, response) => {
      const workspaceId = workspaceIdSchema.safeParse(request.params.id);
      const targetUserId = workspaceIdSchema.safeParse(request.params.userId);
      if (!workspaceId.success || !targetUserId.success) {
        errorResponse(
          response,
          400,
          "INVALID_REQUEST",
          "Workspace or user ID is invalid",
        );
        return;
      }
      const body = validatedBody(removeMemberWithRotationBodySchema, request, response);
      if (!body) return;
      const outcome = await rotateWorkspace(
        workspaceId.data,
        authenticatedUserId(response),
        body,
        targetUserId.data,
      );
      sendRotationOutcome(response, outcome, workspaceId.data, targetUserId.data);
    },
  );

  router.post("/workspaces/:id/leave", async (request, response) => {
    const workspaceId = workspaceIdSchema.safeParse(request.params.id);
    if (!workspaceId.success) {
      errorResponse(response, 400, "INVALID_REQUEST", "Workspace ID is invalid");
      return;
    }
    const userId = authenticatedUserId(response);
    const client = await pool.connect();
    let ownerId: string | null = null;
    try {
      await client.query("BEGIN");
      const locked = await client.query<{ owner_id: string; role: string | null }>(
        `SELECT w.owner_id, m.role FROM workspaces w
         LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2
         WHERE w.id = $1 FOR UPDATE OF w`,
        [workspaceId.data, userId],
      );
      const record = locked.rows[0];
      if (!record || !record.role) {
        await client.query("ROLLBACK");
        errorResponse(response, 404, "NOT_FOUND", "Workspace not found");
        return;
      }
      if (record.role === "owner") {
        await client.query("ROLLBACK");
        errorResponse(response, 403, "OWNER_CANNOT_LEAVE", "The owner cannot leave the workspace");
        return;
      }
      ownerId = record.owner_id;
      await client.query("DELETE FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2", [workspaceId.data, userId]);
      await client.query("DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [workspaceId.data, userId]);
      await client.query("UPDATE workspaces SET needs_rotation = true WHERE id = $1", [workspaceId.data]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    workspaceHub?.removeMember(workspaceId.data, userId);
    if (ownerId) workspaceHub?.rotationNeeded(workspaceId.data, ownerId);
    response.json({ left: true, needsRotation: true });
  });

  router.use((_request, response) => {
    errorResponse(response, 404, "NOT_FOUND", "API route not found");
  });
  router.use(failureHandler);
  return router;
}
