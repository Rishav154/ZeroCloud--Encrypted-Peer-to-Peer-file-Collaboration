import { z } from "zod";

export const identityAlgorithmSchema = z.enum(["X25519", "P-256"]);

export const registerBodySchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(10).max(1024),
  displayName: z.string().trim().min(1).max(80),
  publicKey: z.string().min(1).max(256),
  keyAlg: identityAlgorithmSchema,
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export const loginBodySchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
});
