import { describe, expect, it } from "vitest";
import { IdentityTransform, chunkCount } from "@zerocloud/shared";

describe("web transfer primitives", () => {
  it("uses the shared 16 KiB chunk size boundaries", () => {
    expect([0, 1, 16383, 16384, 16385].map((size) => chunkCount(size))).toEqual(
      [0, 1, 1, 1, 2],
    );
  });
  it("passes bytes through the configured default transform", async () => {
    const input = new Uint8Array([11, 12]);
    const context = { transferId: 3, index: 1 };
    expect(
      await IdentityTransform.decode(
        await IdentityTransform.encode(input, context),
        context,
      ),
    ).toEqual(input);
  });
});
