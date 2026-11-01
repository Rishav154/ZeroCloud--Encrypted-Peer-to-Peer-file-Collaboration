import { describe, expect, it } from "vitest";
import {
  IdentityTransform,
  chunkCount,
  fileAcceptSchema,
  fileAckSchema,
  fileCancelSchema,
  fileCompleteSchema,
  fileOfferSchema,
  fileRejectSchema,
  packChunk,
  unpackChunk,
} from "./index.js";

describe("chunk framing", () => {
  it("round trips the transfer header and payload", () => {
    const payload = new Uint8Array([3, 4, 5]);
    expect(unpackChunk(packChunk(42, 7, payload))).toEqual({
      transferId: 42,
      index: 7,
      payload,
    });
  });
  it("rejects buffers shorter than the header", () => {
    expect(() => unpackChunk(new ArrayBuffer(7))).toThrow();
  });
  it("supports maximum uint32 header values", () => {
    const result = unpackChunk(
      packChunk(0xffffffff, 0xffffffff, new Uint8Array()),
    );
    expect(result.transferId).toBe(0xffffffff);
    expect(result.index).toBe(0xffffffff);
  });
});

describe("transfer helpers and schemas", () => {
  it.each([
    [0, 0],
    [1, 1],
    [16383, 1],
    [16384, 1],
    [16385, 2],
    [100 * 1024 * 1024, 6400],
  ])("counts chunks for %i bytes", (size, expected) => {
    expect(chunkCount(size)).toBe(expected);
  });
  it("validates each control message and rejects malformed shapes", () => {
    const valid = [
      [fileOfferSchema, { type: "file-offer", transferId: 1, sealed: "AA==" }],
      [fileAcceptSchema, { type: "file-accept", transferId: 1 }],
      [fileRejectSchema, { type: "file-reject", transferId: 1, reason: "no" }],
      [fileCompleteSchema, { type: "file-complete", transferId: 1 }],
      [fileAckSchema, { type: "file-ack", transferId: 1, ok: true }],
      [fileCancelSchema, { type: "file-cancel", transferId: 1 }],
    ] as const;
    for (const [schema, message] of valid) {
      expect(schema.safeParse(message).success).toBe(true);
      expect(schema.safeParse({ ...message, transferId: -1 }).success).toBe(
        false,
      );
    }
  });
  it("round trips the identity transform", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const context = { transferId: 9, index: 0 };
    const encoded = await IdentityTransform.encode(bytes, context);
    await expect(IdentityTransform.decode(encoded, context)).resolves.toEqual(
      bytes,
    );
  });
});
