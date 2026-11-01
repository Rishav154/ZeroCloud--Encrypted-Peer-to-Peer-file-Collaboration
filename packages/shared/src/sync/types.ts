import type { z } from "zod";
import type { fileEntrySchema } from "./schemas.js";

export type FileEntry = z.infer<typeof fileEntrySchema>;

export type ManifestDiff = {
  pull: FileEntry[];
  adopt: FileEntry[];
  ignore: FileEntry[];
  reject: { entry: unknown; reason: string }[];
};

export type WriterContext = {
  isWriter(authorFingerprint: string): boolean;
};

export type LocalFileMetadata = {
  fileId: string;
  name: string;
  size: number;
  sha256: string;
  author: string;
  authorName: string;
  modifiedAt: number;
};

export type LocalChangeResult = {
  entry: FileEntry;
  lamport: number;
};
