import { z } from "zod";

const url = z.string().url();

export const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: url,
  DIRECT_DATABASE_URL: url.optional(),
  DATABASE_SSL: z.enum(["true", "false"]).default("false"),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30_000),
  DB_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
  ALLOWED_ORIGIN: url,
  WEB_ORIGIN: url,
  JWT_SECRET: z.string().min(32),
  BUILD_SHA: z.string().default("local"),
  BUILD_TIME: z.string().default("unknown"),
  TEST_DATABASE_URL: url.optional(),
}).superRefine((value, context) => {
  if (value.NODE_ENV === "production") {
    if (!value.DIRECT_DATABASE_URL) {
      context.addIssue({ code: "custom", path: ["DIRECT_DATABASE_URL"], message: "is required in production for migrations" });
    }
    if (value.JWT_SECRET === "replace-this-with-a-random-secret-at-least-32-chars") {
      context.addIssue({ code: "custom", path: ["JWT_SECRET"], message: "must not use the example placeholder" });
    }
    for (const key of ["ALLOWED_ORIGIN", "WEB_ORIGIN"] as const) {
      if (new URL(value[key]).protocol !== "https:") {
        context.addIssue({ code: "custom", path: [key], message: "must use HTTPS in production" });
      }
    }
    if (value.DATABASE_SSL !== "true") {
      context.addIssue({ code: "custom", path: ["DATABASE_SSL"], message: "must be true in production" });
    }
  } else {
    for (const key of ["ALLOWED_ORIGIN", "WEB_ORIGIN"] as const) {
      const parsed = new URL(value[key]);
      if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) {
        context.addIssue({ code: "custom", path: [key], message: "HTTP is allowed only for localhost outside production" });
      }
    }
  }
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function parseEnvironment(environment: NodeJS.ProcessEnv): AppConfig & { DIRECT_DATABASE_URL: string } {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return { ...parsed.data, DIRECT_DATABASE_URL: parsed.data.DIRECT_DATABASE_URL ?? parsed.data.DATABASE_URL };
}
