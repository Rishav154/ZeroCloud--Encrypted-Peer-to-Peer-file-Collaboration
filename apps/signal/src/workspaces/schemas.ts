import { z } from "zod";

export const workspaceIdSchema = z.string().uuid();

const base64Envelope = z
  .string()
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);

export const createWorkspaceBodySchema = z.object({
  id: workspaceIdSchema,
  nameSealed: base64Envelope.min(40).max(20_000),
  wrappedKey: base64Envelope.min(80).max(4096),
});

export const createInviteBodySchema = z.object({
  inviteId: z.string().uuid(),
  role: z.enum(["editor", "viewer"]),
  wrappedKey: base64Envelope.min(80).max(4096),
  keyVersion: z.number().int().positive().max(0xffffffff),
  expiresIn: z.enum(["1h", "24h", "7d"]).default("24h"),
});

export const acceptInviteBodySchema = z.object({
  wrappedForSelf: base64Envelope.min(80).max(4096),
});

export const updateMemberRoleBodySchema = z.object({
  role: z.enum(["editor", "viewer"]),
});

const rotationFieldsSchema = z.object({
  newVersion: z.number().int().min(1).max(0xffffffff),
  nameSealed: base64Envelope.min(40).max(20_000),
  wrappedKeys: z
    .array(
      z.object({
        userId: z.string().uuid(),
        wrappedKey: base64Envelope.min(80).max(4096),
      }),
    )
    .max(500),
});

export const rotateWorkspaceBodySchema = rotationFieldsSchema.extend({
  removeUserId: z.string().uuid().optional(),
});

export const removeMemberWithRotationBodySchema = rotationFieldsSchema;
