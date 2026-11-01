import { z } from "zod";

export const MAX_FILES_PER_WORKSPACE = 500;
export const MAX_MANIFEST_SIZE = 1024 * 1024;
export const MAX_SYNC_FILE_SIZE = 500 * 1024 * 1024;

const fileNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.includes("/"), "File names cannot contain '/'")
  .refine(
    (name) => !/[\u0000-\u001f\u007f-\u009f]/u.test(name),
    "File names cannot contain control characters",
  );

export const fileEntrySchema = z
  .object({
    fileId: z.string().uuid(),
    name: fileNameSchema,
    size: z.number().int().safe().min(0).max(MAX_SYNC_FILE_SIZE),
    sha256: z.string().regex(/^(?:[a-f0-9]{64})?$/),
    lamport: z.number().int().safe().min(1),
    author: z.string().regex(/^[a-f0-9]{64}$/),
    authorName: z.string().min(1).max(80),
    modifiedAt: z.number().int().safe().nonnegative(),
    deleted: z.boolean(),
  })
  .superRefine((entry, context) => {
    if (entry.deleted && (entry.size !== 0 || entry.sha256 !== "")) {
      context.addIssue({
        code: "custom",
        message: "A tombstone must have size 0 and an empty hash",
      });
    }
    if (!entry.deleted && !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      context.addIssue({
        code: "custom",
        message: "A live entry must contain a SHA-256 hash",
      });
    }
  });

export const liveFileEntryInputSchema = z.object({
  fileId: z.string().uuid(),
  name: fileNameSchema,
  size: z.number().int().safe().min(0).max(MAX_SYNC_FILE_SIZE),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  author: z.string().regex(/^[a-f0-9]{64}$/),
  authorName: z.string().min(1).max(80),
  modifiedAt: z.number().int().safe().nonnegative(),
});
