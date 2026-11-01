import express from "express";
import dotenv from "dotenv";
import { Pool } from "pg";
import request from "supertest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import {
  fingerprintPublicKey,
  generateIdentityKeyPair,
  parseServerMessage,
  type IdentityKeyPair,
  type ServerSignalMessage,
} from "@zerocloud/shared";
import { SignJWT } from "jose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApiRouter } from "../api.js";
import { migrateDatabase } from "../db/migrate.js";
import { WorkspaceHub } from "../workspaceHub.js";

dotenv.config({ path: "../../.env" });
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const jwtSecret =
  process.env.JWT_SECRET ?? "test-secret-must-be-at-least-32-characters";
const testConfig = {
  JWT_SECRET: jwtSecret,
};

if (!testDatabaseUrl) {
  throw new Error(
    "Set TEST_DATABASE_URL to the isolated zerocloud_test database before running API tests",
  );
}
if (new URL(testDatabaseUrl).pathname.replace(/^\//, "") !== "zerocloud_test") {
  throw new Error(
    "API tests refuse to run unless TEST_DATABASE_URL points to zerocloud_test",
  );
}

const pool = new Pool({ connectionString: testDatabaseUrl });

function apiClient() {
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/api", createApiRouter(pool, testConfig));
  return request(app);
}

function nextSocketMessage(
  socket: WebSocket,
  expectedType?: ServerSignalMessage["type"],
): Promise<ServerSignalMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for WebSocket message")),
      3000,
    );
    const onMessage = (raw: RawData): void => {
      const parsed = parseServerMessage(raw.toString());
      if (parsed.success && expectedType && parsed.data.type !== expectedType)
        return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      if (!parsed.success) reject(new Error(parsed.error));
      else resolve(parsed.data);
    };
    socket.on("message", onMessage);
  });
}

async function openAuthenticatedSocket(
  server: WebSocketServer,
  token: string,
): Promise<WebSocket> {
  const address = server.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const authenticated = nextSocketMessage(socket);
  socket.send(JSON.stringify({ type: "auth", token }));
  await authenticated;
  return socket;
}

async function identityPair(forceP256 = false): Promise<{
  pair: IdentityKeyPair;
  fingerprint: string;
}> {
  const pair = await generateIdentityKeyPair(forceP256);
  return { pair, fingerprint: await fingerprintPublicKey(pair.publicKeyRaw) };
}

async function register(
  client: ReturnType<typeof apiClient>,
  email: string,
  identityInput?: Awaited<ReturnType<typeof identityPair>>,
  password = "correct-horse-battery",
) {
  const identity = identityInput ?? (await identityPair());
  return client.post("/api/auth/register").send({
    email,
    password,
    displayName: "Test User",
    publicKey: Buffer.from(identity.pair.publicKeyRaw).toString("base64"),
    keyAlg: identity.pair.algorithm,
    fingerprint: identity.fingerprint,
  });
}

beforeAll(async () => {
  await migrateDatabase(pool);
});

beforeEach(async () => {
  await pool.query(
    "TRUNCATE invites, workspace_keys, workspace_members, workspaces, users CASCADE",
  );
});

afterAll(async () => {
  await pool.end();
});

describe("account API", () => {
  it("registers and logs in with a normalized email", async () => {
    const client = apiClient();
    const identity = await identityPair();
    const created = await register(client, "  Person@Example.com ", identity);
    expect(created.status).toBe(201);
    expect(created.body.user.email).toBe("person@example.com");
    expect(created.body.user.fingerprint).toBe(identity.fingerprint);
    expect(typeof created.body.accessToken).toBe("string");

    const login = await client.post("/api/auth/login").send({
      email: "PERSON@example.com",
      password: "correct-horse-battery",
    });
    expect(login.status).toBe(200);
    expect(login.body.user.fingerprint).toBe(identity.fingerprint);
  });

  it("rejects duplicate email and duplicate fingerprint distinctly", async () => {
    const client = apiClient();
    const firstIdentity = await identityPair();
    const secondIdentity = await identityPair();
    expect(
      (await register(client, "person@example.com", firstIdentity)).status,
    ).toBe(201);

    const duplicateEmail = await register(
      client,
      "PERSON@example.com",
      secondIdentity,
    );
    expect(duplicateEmail.status).toBe(409);
    expect(duplicateEmail.body.error.code).toBe("EMAIL_EXISTS");

    const duplicateIdentity = await register(
      client,
      "other@example.com",
      firstIdentity,
    );
    expect(duplicateIdentity.status).toBe(409);
    expect(duplicateIdentity.body.error.code).toBe("IDENTITY_ALREADY_BOUND");
  });

  it("rejects a fingerprint mismatch and a weak password", async () => {
    const client = apiClient();
    const identity = await identityPair();
    const mismatch = await client.post("/api/auth/register").send({
      email: "person@example.com",
      password: "correct-horse-battery",
      displayName: "Test User",
      publicKey: Buffer.from(identity.pair.publicKeyRaw).toString("base64"),
      keyAlg: identity.pair.algorithm,
      fingerprint: "0".repeat(64),
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe("FINGERPRINT_MISMATCH");

    const weak = await client.post("/api/auth/register").send({
      email: "person@example.com",
      password: "short",
      displayName: "Test User",
      publicKey: Buffer.from(identity.pair.publicKeyRaw).toString("base64"),
      keyAlg: identity.pair.algorithm,
      fingerprint: identity.fingerprint,
    });
    expect(weak.status).toBe(400);
  });

  it("uses the same invalid-credentials response for unknown email and wrong password", async () => {
    const client = apiClient();
    const identity = await identityPair();
    await register(client, "known@example.com", identity);
    const wrongPassword = await client.post("/api/auth/login").send({
      email: "known@example.com",
      password: "incorrect-password",
    });
    const unknownEmail = await client.post("/api/auth/login").send({
      email: "unknown@example.com",
      password: "incorrect-password",
    });
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  it("requires valid sessions on protected endpoints", async () => {
    const client = apiClient();
    const noToken = await client.get("/api/me");
    expect(noToken.status).toBe(401);
    const badToken = await client
      .get("/api/me")
      .set("authorization", "Bearer invalid");
    expect(badToken.status).toBe(401);
    const expiredToken = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("zerocloud")
      .setSubject(crypto.randomUUID())
      .setIssuedAt()
      .setExpirationTime("0s")
      .sign(new TextEncoder().encode(jwtSecret));
    const expired = await client
      .get("/api/me")
      .set("authorization", `Bearer ${expiredToken}`);
    expect(expired.status).toBe(401);
  });

  it("rate limits authentication attempts per client IP", async () => {
    const client = apiClient();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await client.post("/api/auth/login").send({
        email: "unknown@example.com",
        password: "incorrect-password",
      });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe("workspace API", () => {
  it("creates sealed workspace metadata with a self-wrapped key and lists its owner", async () => {
    const client = apiClient();
    const identity = await identityPair();
    const registered = await register(client, "owner@example.com", identity);
    const token = registered.body.accessToken as string;
    const id = crypto.randomUUID();
    const nameSealed = Buffer.from("sealed workspace name payload").toString(
      "base64",
    );
    const wrappedKey = Buffer.alloc(60, 2).toString("base64");
    const created = await client
      .post("/api/workspaces")
      .set("authorization", `Bearer ${token}`)
      .send({ id, nameSealed, wrappedKey });
    expect(created.status).toBe(201);

    const stored = await pool.query(
      "SELECT name_sealed FROM workspaces WHERE id = $1",
      [id],
    );
    expect(stored.rows[0]?.name_sealed).toBe(nameSealed);
    expect(JSON.stringify(stored.rows[0])).not.toContain("Research workspace");
    const keys = await pool.query(
      "SELECT wrapped_key, key_version FROM workspace_keys WHERE workspace_id = $1",
      [id],
    );
    expect(keys.rows).toEqual([{ wrapped_key: wrappedKey, key_version: 1 }]);

    const list = await client
      .get("/api/workspaces")
      .set("authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    expect(list.body.workspaces).toEqual([
      { id, nameSealed, currentKeyVersion: 1, needsRotation: false, role: "owner" },
    ]);
    const detail = await client
      .get(`/api/workspaces/${id}`)
      .set("authorization", `Bearer ${token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.workspace.wrappedKey).toBe(wrappedKey);
    expect(detail.body.members[0].fingerprint).toBe(identity.fingerprint);
    expect(detail.body.members[0].publicKey).toBe(
      Buffer.from(identity.pair.publicKeyRaw).toString("base64"),
    );
  });

  it("returns 404 when a non-member requests a workspace", async () => {
    const client = apiClient();
    const ownerIdentity = await identityPair();
    const outsiderIdentity = await identityPair();
    const owner = await register(client, "owner@example.com", ownerIdentity);
    const outsider = await register(
      client,
      "outsider@example.com",
      outsiderIdentity,
    );
    const workspaceId = crypto.randomUUID();
    await client
      .post("/api/workspaces")
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        id: workspaceId,
        nameSealed: Buffer.from("sealed workspace title payload").toString(
          "base64",
        ),
        wrappedKey: Buffer.alloc(60, 3).toString("base64"),
      });
    const response = await client
      .get(`/api/workspaces/${workspaceId}`)
      .set("authorization", `Bearer ${outsider.body.accessToken as string}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("restricts invite, role, and removal administration to the owner", async () => {
    const client = apiClient();
    const owner = await register(client, "owner-b@example.com");
    const editor = await register(client, "editor-b@example.com");
    const workspaceId = crypto.randomUUID();
    await client
      .post("/api/workspaces")
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        id: workspaceId,
        nameSealed: Buffer.alloc(40, 5).toString("base64"),
        wrappedKey: Buffer.alloc(60, 6).toString("base64"),
      });
    const editorInviteId = crypto.randomUUID();
    await client
      .post(`/api/workspaces/${workspaceId}/invites`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        inviteId: editorInviteId,
        role: "editor",
        wrappedKey: Buffer.alloc(60, 27).toString("base64"),
        keyVersion: 1,
        expiresIn: "24h",
      });
    await client
      .post(`/api/invites/${editorInviteId}/accept`)
      .set("authorization", `Bearer ${editor.body.accessToken as string}`)
      .send({ wrappedForSelf: Buffer.alloc(60, 28).toString("base64") });
    const inviteId = crypto.randomUUID();
    const payload = {
      inviteId,
      role: "viewer",
      wrappedKey: Buffer.alloc(60, 7).toString("base64"),
      keyVersion: 1,
      expiresIn: "24h",
    };
    const forbiddenInvite = await client
      .post(`/api/workspaces/${workspaceId}/invites`)
      .set("authorization", `Bearer ${editor.body.accessToken as string}`)
      .send(payload);
    expect(forbiddenInvite.status).toBe(403);
    const createdInvite = await client
      .post(`/api/workspaces/${workspaceId}/invites`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send(payload);
    expect(createdInvite.status).toBe(201);
    const ownerRoleInvite = await client
      .post(`/api/workspaces/${workspaceId}/invites`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({ ...payload, inviteId: crypto.randomUUID(), role: "owner" });
    expect(ownerRoleInvite.status).toBe(400);
    const forbiddenRole = await client
      .patch(
        `/api/workspaces/${workspaceId}/members/${owner.body.user.id as string}`,
      )
      .set("authorization", `Bearer ${editor.body.accessToken as string}`)
      .send({ role: "viewer" });
    expect(forbiddenRole.status).toBe(403);
    const forbiddenRemove = await client
      .delete(
        `/api/workspaces/${workspaceId}/members/${owner.body.user.id as string}`,
      )
      .set("authorization", `Bearer ${editor.body.accessToken as string}`)
      .send({ newVersion: 2, nameSealed: Buffer.alloc(40, 61).toString("base64"), wrappedKeys: [{ userId: editor.body.user.id as string, wrappedKey: Buffer.alloc(60, 62).toString("base64") }] });
    expect(forbiddenRemove.status).toBe(403);
    const forbiddenRevoke = await client
      .delete(`/api/workspaces/${workspaceId}/invites/${inviteId}`)
      .set("authorization", `Bearer ${editor.body.accessToken as string}`);
    expect(forbiddenRevoke.status).toBe(403);
  });

  it("accepts an invite once, assigns its role, and rejects reuse", async () => {
    const client = apiClient();
    const owner = await register(client, "invite-owner@example.com");
    const invitee = await register(client, "invitee@example.com");
    const workspaceId = crypto.randomUUID();
    await client
      .post("/api/workspaces")
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        id: workspaceId,
        nameSealed: Buffer.alloc(40, 8).toString("base64"),
        wrappedKey: Buffer.alloc(60, 9).toString("base64"),
      });
    const inviteId = crypto.randomUUID();
    const wrappedKey = Buffer.alloc(60, 10).toString("base64");
    const created = await client
      .post(`/api/workspaces/${workspaceId}/invites`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        inviteId,
        role: "viewer",
        wrappedKey,
        keyVersion: 1,
        expiresIn: "24h",
      });
    expect(created.status).toBe(201);
    const accepted = await client
      .post(`/api/invites/${inviteId}/accept`)
      .set("authorization", `Bearer ${invitee.body.accessToken as string}`)
      .send({ wrappedForSelf: Buffer.alloc(60, 11).toString("base64") });
    expect(accepted.status).toBe(200);
    expect(accepted.body.role).toBe("viewer");
    expect(
      (
        await client
          .post(`/api/invites/${inviteId}/accept`)
          .set("authorization", `Bearer ${owner.body.accessToken as string}`)
          .send({ wrappedForSelf: Buffer.alloc(60, 12).toString("base64") })
      ).status,
    ).toBe(404);
    const storedKey = await pool.query(
      "SELECT wrapped_key FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2",
      [workspaceId, invitee.body.user.id],
    );
    expect(storedKey.rows[0]?.wrapped_key).toBe(
      Buffer.alloc(60, 11).toString("base64"),
    );
  });

  it("does not consume an invite when an existing member tries to accept it", async () => {
    const client = apiClient();
    const owner = await register(client, "already-owner@example.com");
    const outsider = await register(client, "already-outside@example.com");
    const workspaceId = crypto.randomUUID();
    await client
      .post("/api/workspaces")
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        id: workspaceId,
        nameSealed: Buffer.alloc(40, 13).toString("base64"),
        wrappedKey: Buffer.alloc(60, 14).toString("base64"),
      });
    const inviteId = crypto.randomUUID();
    await client
      .post(`/api/workspaces/${workspaceId}/invites`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        inviteId,
        role: "editor",
        wrappedKey: Buffer.alloc(60, 15).toString("base64"),
        keyVersion: 1,
        expiresIn: "24h",
      });
    expect(
      (
        await client
          .post(`/api/invites/${inviteId}/accept`)
          .set("authorization", `Bearer ${owner.body.accessToken as string}`)
          .send({ wrappedForSelf: Buffer.alloc(60, 16).toString("base64") })
      ).status,
    ).toBe(409);
    expect(
      (
        await client
          .post(`/api/invites/${inviteId}/accept`)
          .set("authorization", `Bearer ${outsider.body.accessToken as string}`)
          .send({ wrappedForSelf: Buffer.alloc(60, 17).toString("base64") })
      ).status,
    ).toBe(200);
  });

  it("serializes simultaneous invite redemption so only one account succeeds", async () => {
    const client = apiClient();
    const owner = await register(client, "race-owner@example.com");
    const first = await register(client, "race-first@example.com");
    const second = await register(client, "race-second@example.com");
    const workspaceId = crypto.randomUUID();
    await client
      .post("/api/workspaces")
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        id: workspaceId,
        nameSealed: Buffer.alloc(40, 18).toString("base64"),
        wrappedKey: Buffer.alloc(60, 19).toString("base64"),
      });
    const inviteId = crypto.randomUUID();
    await client
      .post(`/api/workspaces/${workspaceId}/invites`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        inviteId,
        role: "editor",
        wrappedKey: Buffer.alloc(60, 20).toString("base64"),
        keyVersion: 1,
        expiresIn: "24h",
      });
    const responses = await Promise.all(
      [first, second].map((account) =>
        client
          .post(`/api/invites/${inviteId}/accept`)
          .set("authorization", `Bearer ${account.body.accessToken as string}`)
          .send({ wrappedForSelf: Buffer.alloc(60, 21).toString("base64") }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 404,
    ]);
  });

  it("revokes invites and removes a member's wrapped workspace key", async () => {
    const client = apiClient();
    const owner = await register(client, "remove-owner@example.com");
    const member = await register(client, "remove-member@example.com");
    const workspaceId = crypto.randomUUID();
    await client
      .post("/api/workspaces")
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        id: workspaceId,
        nameSealed: Buffer.alloc(40, 22).toString("base64"),
        wrappedKey: Buffer.alloc(60, 23).toString("base64"),
      });
    const inviteId = crypto.randomUUID();
    await client
      .post(`/api/workspaces/${workspaceId}/invites`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        inviteId,
        role: "editor",
        wrappedKey: Buffer.alloc(60, 24).toString("base64"),
        keyVersion: 1,
        expiresIn: "24h",
      });
    const revoked = await client
      .delete(`/api/workspaces/${workspaceId}/invites/${inviteId}`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`);
    expect(revoked.status).toBe(200);
    expect(
      (
        await client
          .get(`/api/invites/${inviteId}`)
          .set("authorization", `Bearer ${member.body.accessToken as string}`)
      ).status,
    ).toBe(404);
    const expiredInviteId = crypto.randomUUID();
    await client
      .post(`/api/workspaces/${workspaceId}/invites`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        inviteId: expiredInviteId,
        role: "viewer",
        wrappedKey: Buffer.alloc(60, 36).toString("base64"),
        keyVersion: 1,
        expiresIn: "24h",
      });
    await pool.query(
      "UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = $1",
      [expiredInviteId],
    );
    const expiredAccept = await client
      .post(`/api/invites/${expiredInviteId}/accept`)
      .set("authorization", `Bearer ${member.body.accessToken as string}`)
      .send({ wrappedForSelf: Buffer.alloc(60, 37).toString("base64") });
    expect(expiredAccept.status).toBe(404);
    const anotherId = crypto.randomUUID();
    await client
      .post(`/api/workspaces/${workspaceId}/invites`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        inviteId: anotherId,
        role: "editor",
        wrappedKey: Buffer.alloc(60, 25).toString("base64"),
        keyVersion: 1,
        expiresIn: "24h",
      });
    await client
      .post(`/api/invites/${anotherId}/accept`)
      .set("authorization", `Bearer ${member.body.accessToken as string}`)
      .send({ wrappedForSelf: Buffer.alloc(60, 26).toString("base64") });
    const removed = await client
      .delete(
        `/api/workspaces/${workspaceId}/members/${member.body.user.id as string}`,
      )
      .set("authorization", `Bearer ${owner.body.accessToken as string}`);
    expect(removed.status).toBe(400);
    const preparedRemoval = await client
      .delete(`/api/workspaces/${workspaceId}/members/${member.body.user.id as string}`)
      .set("authorization", `Bearer ${owner.body.accessToken as string}`)
      .send({
        newVersion: 2,
        nameSealed: Buffer.alloc(40, 28).toString("base64"),
        wrappedKeys: [{ userId: owner.body.user.id as string, wrappedKey: Buffer.alloc(60, 29).toString("base64") }],
      });
    expect(preparedRemoval.status).toBe(200);
    expect(preparedRemoval.body.version).toBe(2);
    expect(
      (
        await pool.query(
          "SELECT 1 FROM workspace_keys WHERE workspace_id = $1 AND user_id = $2",
          [workspaceId, member.body.user.id],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await client
          .get(`/api/workspaces/${workspaceId}`)
          .set("authorization", `Bearer ${member.body.accessToken as string}`)
      ).status,
    ).toBe(404);
  });
});

describe("workspace key rotation", () => {
  it("rotates keys transactionally, serves all versions, and rejects old-version invites", async () => {
    const client = apiClient();
    const owner = await register(client, "rotate-owner@example.com");
    const member = await register(client, "rotate-member@example.com");
    const workspaceId = crypto.randomUUID();
    const ownerToken = owner.body.accessToken as string;
    const memberToken = member.body.accessToken as string;
    await client.post("/api/workspaces").set("authorization", `Bearer ${ownerToken}`).send({
      id: workspaceId,
      nameSealed: Buffer.alloc(40, 41).toString("base64"),
      wrappedKey: Buffer.alloc(60, 42).toString("base64"),
    });
    const staleInviteId = crypto.randomUUID();
    await client.post(`/api/workspaces/${workspaceId}/invites`).set("authorization", `Bearer ${ownerToken}`).send({
      inviteId: staleInviteId,
      role: "editor",
      wrappedKey: Buffer.alloc(60, 43).toString("base64"),
      keyVersion: 1,
    });
    const rotateBody = {
      newVersion: 2,
      nameSealed: Buffer.alloc(40, 44).toString("base64"),
      wrappedKeys: [
        { userId: owner.body.user.id as string, wrappedKey: Buffer.alloc(60, 45).toString("base64") },
      ],
    };
    const missingRecipient = await client.post(`/api/workspaces/${workspaceId}/rotate`).set("authorization", `Bearer ${ownerToken}`).send({ ...rotateBody, wrappedKeys: [] });
    expect(missingRecipient.status).toBe(409);
    expect(missingRecipient.body.code).toBe("MEMBERS_CHANGED");
    const unchanged = await client.get(`/api/workspaces/${workspaceId}`).set("authorization", `Bearer ${ownerToken}`);
    expect(unchanged.body.workspace.currentKeyVersion).toBe(1);
    const rotated = await client.post(`/api/workspaces/${workspaceId}/rotate`).set("authorization", `Bearer ${ownerToken}`).send(rotateBody);
    expect(rotated.status).toBe(200);
    expect(rotated.body).toMatchObject({ version: 2, needsRotation: false });
    const keys = await client.get(`/api/workspaces/${workspaceId}/keys`).set("authorization", `Bearer ${ownerToken}`);
    expect(keys.status).toBe(200);
    expect(keys.body.keys.map((entry: { keyVersion: number }) => entry.keyVersion)).toEqual([1, 2]);
    const staleAccept = await client.post(`/api/invites/${staleInviteId}/accept`).set("authorization", `Bearer ${memberToken}`).send({ wrappedForSelf: Buffer.alloc(60, 46).toString("base64") });
    expect(staleAccept.status).toBe(404);
  });

  it("requires rotation payloads for removal and marks a leaving member for rotation", async () => {
    const client = apiClient();
    const owner = await register(client, "leave-owner@example.com");
    const member = await register(client, "leave-member@example.com");
    const workspaceId = crypto.randomUUID();
    const ownerToken = owner.body.accessToken as string;
    const memberToken = member.body.accessToken as string;
    await client.post("/api/workspaces").set("authorization", `Bearer ${ownerToken}`).send({
      id: workspaceId,
      nameSealed: Buffer.alloc(40, 47).toString("base64"),
      wrappedKey: Buffer.alloc(60, 48).toString("base64"),
    });
    const inviteId = crypto.randomUUID();
    await client.post(`/api/workspaces/${workspaceId}/invites`).set("authorization", `Bearer ${ownerToken}`).send({
      inviteId,
      role: "editor",
      wrappedKey: Buffer.alloc(60, 49).toString("base64"),
      keyVersion: 1,
    });
    await client.post(`/api/invites/${inviteId}/accept`).set("authorization", `Bearer ${memberToken}`).send({ wrappedForSelf: Buffer.alloc(60, 50).toString("base64") });
    const left = await client.post(`/api/workspaces/${workspaceId}/leave`).set("authorization", `Bearer ${memberToken}`).send({});
    expect(left.status).toBe(200);
    expect(left.body.needsRotation).toBe(true);
    const detail = await client.get(`/api/workspaces/${workspaceId}`).set("authorization", `Bearer ${ownerToken}`);
    expect(detail.body.workspace.needsRotation).toBe(true);
    const noPayload = await client.delete(`/api/workspaces/${workspaceId}/members/${member.body.user.id as string}`).set("authorization", `Bearer ${ownerToken}`);
    expect(noPayload.status).toBe(400);
  });

  it("serializes concurrent rotations at one version", async () => {
    const client = apiClient();
    const owner = await register(client, "concurrent-rotate@example.com");
    const token = owner.body.accessToken as string;
    const workspaceId = crypto.randomUUID();
    await client.post("/api/workspaces").set("authorization", `Bearer ${token}`).send({
      id: workspaceId,
      nameSealed: Buffer.alloc(40, 51).toString("base64"),
      wrappedKey: Buffer.alloc(60, 52).toString("base64"),
    });
    const body = {
      newVersion: 2,
      nameSealed: Buffer.alloc(40, 53).toString("base64"),
      wrappedKeys: [{ userId: owner.body.user.id as string, wrappedKey: Buffer.alloc(60, 54).toString("base64") }],
    };
    const results = await Promise.all([
      client.post(`/api/workspaces/${workspaceId}/rotate`).set("authorization", `Bearer ${token}`).send(body),
      client.post(`/api/workspaces/${workspaceId}/rotate`).set("authorization", `Bearer ${token}`).send(body),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
  });
});

describe("authenticated workspace signaling", () => {
  it("closes sockets that do not authenticate within five seconds", async () => {
    const hub = new WorkspaceHub(pool, jwtSecret);
    const server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket) => hub.accept(socket));
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    expect(await closed).toBe(4401);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }, 8000);

  it("refuses non-members and never relays signals across workspace rooms", async () => {
    const hub = new WorkspaceHub(pool, jwtSecret);
    const app = express();
    app.use(express.json({ limit: "64kb" }));
    app.use("/api", createApiRouter(pool, testConfig, hub));
    const client = request(app);
    const owner = await register(client, "socket-owner@example.com");
    const member = await register(client, "socket-member@example.com");
    const outsider = await register(client, "socket-outsider@example.com");
    const firstWorkspaceId = crypto.randomUUID();
    const secondWorkspaceId = crypto.randomUUID();
    const ownerToken = owner.body.accessToken as string;
    const memberToken = member.body.accessToken as string;
    const outsiderToken = outsider.body.accessToken as string;
    await client
      .post("/api/workspaces")
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        id: firstWorkspaceId,
        nameSealed: Buffer.alloc(40, 30).toString("base64"),
        wrappedKey: Buffer.alloc(60, 31).toString("base64"),
      });
    const inviteId = crypto.randomUUID();
    await client
      .post(`/api/workspaces/${firstWorkspaceId}/invites`)
      .set("authorization", `Bearer ${ownerToken}`)
      .send({
        inviteId,
        role: "editor",
        wrappedKey: Buffer.alloc(60, 32).toString("base64"),
        keyVersion: 1,
        expiresIn: "24h",
      });
    await client
      .post(`/api/invites/${inviteId}/accept`)
      .set("authorization", `Bearer ${memberToken}`)
      .send({ wrappedForSelf: Buffer.alloc(60, 33).toString("base64") });
    await client
      .post("/api/workspaces")
      .set("authorization", `Bearer ${outsiderToken}`)
      .send({
        id: secondWorkspaceId,
        nameSealed: Buffer.alloc(40, 34).toString("base64"),
        wrappedKey: Buffer.alloc(60, 35).toString("base64"),
      });

    const server = new WebSocketServer({ port: 0 });
    server.on("connection", (socket) => hub.accept(socket));
    await once(server, "listening");
    const sockets: WebSocket[] = [];
    try {
      const ownerSocket = await openAuthenticatedSocket(server, ownerToken);
      sockets.push(ownerSocket);
      const ownerPeerId = crypto.randomUUID();
      const ownerJoined = nextSocketMessage(ownerSocket);
      ownerSocket.send(
        JSON.stringify({
          type: "join",
          workspaceId: firstWorkspaceId,
          peerId: ownerPeerId,
        }),
      );
      expect((await ownerJoined).type).toBe("joined");

      const memberSocket = await openAuthenticatedSocket(server, memberToken);
      sockets.push(memberSocket);
      const memberPeerId = crypto.randomUUID();
      const joined = nextSocketMessage(memberSocket);
      const peerJoined = nextSocketMessage(ownerSocket);
      memberSocket.send(
        JSON.stringify({
          type: "join",
          workspaceId: firstWorkspaceId,
          peerId: memberPeerId,
        }),
      );
      expect((await joined).type).toBe("joined");
      expect((await peerJoined).type).toBe("peer-joined");

      const ownerRoleChanged = nextSocketMessage(ownerSocket);
      const memberRoleChanged = nextSocketMessage(memberSocket);
      const roleResponse = await client
        .patch(
          `/api/workspaces/${firstWorkspaceId}/members/${member.body.user.id as string}`,
        )
        .set("authorization", `Bearer ${ownerToken}`)
        .send({ role: "viewer" });
      expect(roleResponse.status).toBe(200);
      expect((await ownerRoleChanged).type).toBe("role-changed");
      expect((await memberRoleChanged).type).toBe("role-changed");

      const outsiderSocket = await openAuthenticatedSocket(
        server,
        outsiderToken,
      );
      sockets.push(outsiderSocket);
      const outsiderPeerId = crypto.randomUUID();
      const outsiderJoined = nextSocketMessage(outsiderSocket);
      outsiderSocket.send(
        JSON.stringify({
          type: "join",
          workspaceId: secondWorkspaceId,
          peerId: outsiderPeerId,
        }),
      );
      expect((await outsiderJoined).type).toBe("joined");
      const crossRoomResult = nextSocketMessage(ownerSocket);
      ownerSocket.send(
        JSON.stringify({
          type: "signal",
          to: outsiderPeerId,
          data: { kind: "offer", sdp: "private sdp" },
        }),
      );
      const rejected = await crossRoomResult;
      expect(rejected).toMatchObject({ type: "error", code: "PEER_NOT_FOUND" });

      const nonMemberSocket = await openAuthenticatedSocket(
        server,
        outsiderToken,
      );
      sockets.push(nonMemberSocket);
      const nonMemberJoined = nextSocketMessage(nonMemberSocket);
      nonMemberSocket.send(
        JSON.stringify({
          type: "join",
          workspaceId: firstWorkspaceId,
          peerId: crypto.randomUUID(),
        }),
      );
      expect(await nonMemberJoined).toMatchObject({
        type: "error",
        code: "NOT_A_MEMBER",
      });

      const memberKicked = nextSocketMessage(memberSocket, "kicked");
      const ownerMemberRemoved = nextSocketMessage(
        ownerSocket,
        "member-removed",
      );
      const ownerPeerLeft = nextSocketMessage(ownerSocket, "peer-left");
      const removal = await client
        .delete(
          `/api/workspaces/${firstWorkspaceId}/members/${member.body.user.id as string}`,
        )
        .set("authorization", `Bearer ${ownerToken}`)
        .send({ newVersion: 2, nameSealed: Buffer.alloc(40, 63).toString("base64"), wrappedKeys: [{ userId: owner.body.user.id as string, wrappedKey: Buffer.alloc(60, 64).toString("base64") }] });
      expect(removal.status).toBe(200);
      expect((await memberKicked).type).toBe("kicked");
      expect((await ownerMemberRemoved).type).toBe("member-removed");
      expect((await ownerPeerLeft).type).toBe("peer-left");
      const removedSocket = await openAuthenticatedSocket(server, memberToken);
      sockets.push(removedSocket);
      const rejoinResponse = nextSocketMessage(removedSocket);
      removedSocket.send(
        JSON.stringify({
          type: "join",
          workspaceId: firstWorkspaceId,
          peerId: crypto.randomUUID(),
        }),
      );
      expect(await rejoinResponse).toMatchObject({
        type: "error",
        code: "NOT_A_MEMBER",
      });
    } finally {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
