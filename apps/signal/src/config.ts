import dotenv from "dotenv";
import { z } from "zod";

dotenv.config({ path: "../../.env" });

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().url(),
  ALLOWED_ORIGIN: z.string().url(),
  WEB_ORIGIN: z.string().url(),
  JWT_SECRET: z.string().min(32),
  TEST_DATABASE_URL: z.string().url().optional(),
});

const result = environmentSchema.safeParse(process.env);
if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  throw new Error(`Invalid environment configuration: ${details}`);
}

export const config = result.data;
