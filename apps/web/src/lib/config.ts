import { z } from "zod";

const publicConfigSchema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
  NEXT_PUBLIC_SIGNAL_URL: z.string().url(),
  NEXT_PUBLIC_STUN_URLS: z.string().default("stun:stun.l.google.com:19302"),
  NEXT_PUBLIC_TURN_URL: z.string().default(""),
  NEXT_PUBLIC_TURN_USERNAME: z.string().optional(),
  NEXT_PUBLIC_TURN_CREDENTIAL: z.string().optional(),
  NEXT_PUBLIC_FORCE_RELAY: z.enum(["true", "false"]).default("false"),
  NEXT_PUBLIC_FORCE_P256: z.enum(["true", "false"]).default("false"),
});

const parsed = publicConfigSchema.safeParse({
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api",
  NEXT_PUBLIC_SIGNAL_URL: process.env.NEXT_PUBLIC_SIGNAL_URL ?? "ws://localhost:4000/ws",
  NEXT_PUBLIC_STUN_URLS: process.env.NEXT_PUBLIC_STUN_URLS,
  NEXT_PUBLIC_TURN_URL: process.env.NEXT_PUBLIC_TURN_URL,
  NEXT_PUBLIC_TURN_USERNAME: process.env.NEXT_PUBLIC_TURN_USERNAME,
  NEXT_PUBLIC_TURN_CREDENTIAL: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
  NEXT_PUBLIC_FORCE_RELAY: process.env.NEXT_PUBLIC_FORCE_RELAY,
  NEXT_PUBLIC_FORCE_P256: process.env.NEXT_PUBLIC_FORCE_P256,
});

if (!parsed.success) {
  const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
  throw new Error(`Invalid web configuration: ${detail}`);
}

export const publicConfig = parsed.data;
