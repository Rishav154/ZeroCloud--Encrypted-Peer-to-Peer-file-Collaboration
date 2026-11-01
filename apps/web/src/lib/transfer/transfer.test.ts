import { describe, expect, it } from "vitest";
import { IdentityTransform, chunkCount } from "@zerocloud/shared";
import { FileReceiver } from "./FileReceiver";
import type { PeerCryptoContext } from "./cryptoContext";

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

  it.each(["viewer", null] as const)(
    "auto-rejects an offer when sender role is %s",
    async (role) => {
      const sent: string[] = [];
      const channel = {
        readyState: "open",
        send: (message: string) => sent.push(message),
      } as unknown as RTCDataChannel;
      const receiver = new FileReceiver(
        "remote-peer",
        channel,
        {} as PeerCryptoContext,
        () => role,
      );
      const transferStates: string[] = [];
      receiver.events.on("transfer", (transfer) =>
        transferStates.push(`${transfer.state}:${transfer.error}`),
      );

      await receiver.handleString(
        JSON.stringify({ type: "file-offer", transferId: 12, sealed: "AA==" }),
      );

      expect(sent).toEqual([
        JSON.stringify({
          type: "file-reject",
          transferId: 12,
          reason: "no write permission",
        }),
      ]);
      expect(transferStates).toEqual(["rejected:no write permission"]);
    },
  );
});
