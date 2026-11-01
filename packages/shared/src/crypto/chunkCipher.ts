import { toArrayBuffer } from "./encoding.js";

export class AesGcmChunkTransform {
  constructor(
    private readonly fileKey: CryptoKey,
    private readonly totalChunks: number,
    private readonly transferId: number,
  ) {
    if (
      !Number.isInteger(totalChunks) ||
      totalChunks < 0 ||
      totalChunks > 0xffffffff
    ) {
      throw new RangeError("Total chunk count must be a uint32 integer");
    }
    if (
      !Number.isInteger(transferId) ||
      transferId < 0 ||
      transferId > 0xffffffff
    ) {
      throw new RangeError("Transfer ID must be a uint32 integer");
    }
  }

  async encode(
    chunk: Uint8Array,
    ctx: { transferId: number; index: number },
  ): Promise<Uint8Array> {
    return this.crypt("encrypt", chunk, ctx);
  }

  async decode(
    data: Uint8Array,
    ctx: { transferId: number; index: number },
  ): Promise<Uint8Array> {
    return this.crypt("decrypt", data, ctx);
  }

  private async crypt(
    operation: "encrypt" | "decrypt",
    input: Uint8Array,
    ctx: { transferId: number; index: number },
  ): Promise<Uint8Array> {
    for (const value of [ctx.transferId, ctx.index]) {
      if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new RangeError("Chunk context values must be uint32 integers");
      }
    }
    if (ctx.transferId !== this.transferId) {
      throw new Error("Chunk transfer ID does not match this transform");
    }
    if (ctx.index >= this.totalChunks) {
      throw new RangeError("Chunk index is outside this transfer");
    }
    const iv = new Uint8Array(12);
    new DataView(iv.buffer).setUint32(8, ctx.index, false);
    const aad = new Uint8Array(12);
    const aadView = new DataView(aad.buffer);
    aadView.setUint32(0, ctx.transferId, false);
    aadView.setUint32(4, ctx.index, false);
    aadView.setUint32(8, this.totalChunks, false);
    const result = await crypto.subtle[operation](
      {
        name: "AES-GCM",
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(aad),
        tagLength: 128,
      },
      this.fileKey,
      toArrayBuffer(input),
    );
    return new Uint8Array(result);
  }
}
