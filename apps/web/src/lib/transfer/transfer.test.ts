import { describe, expect, it } from "vitest";
import {
  IdentityTransform,
  bytesToBase64,
  chunkCount,
  seal,
} from "@zerocloud/shared";
import { FileReceiver } from "./FileReceiver";
import { remoteToLocalAad, type PeerCryptoContext } from "./cryptoContext";

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
      const context: PeerCryptoContext = {
        sessionKey: await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        ),
        localFingerprint: "1".repeat(64),
        remoteFingerprint: "2".repeat(64),
        localNonce: new Uint8Array(32).fill(1),
        remoteNonce: new Uint8Array(32).fill(2),
      };
      const receiver = new FileReceiver(
        "remote-peer",
        channel,
        context,
        () => role,
      );
      const transferStates: string[] = [];
      receiver.events.on("transfer", (transfer) =>
        transferStates.push(`${transfer.state}:${transfer.error}`),
      );

      const offer = {
        fileKey: bytesToBase64(new Uint8Array(32).fill(3)),
        name: "test.txt",
        mime: "text/plain",
        size: 0,
        sha256:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        chunkSize: 16 * 1024,
        totalChunks: 0,
        lastModified: 1,
      };
      const sealed = await seal(
        context.sessionKey,
        new TextEncoder().encode(JSON.stringify(offer)),
        remoteToLocalAad(context, "file-offer", 12),
      );
      await receiver.handleString(
        JSON.stringify({
          type: "file-offer",
          transferId: 12,
          sealed: bytesToBase64(sealed),
        }),
      );

      const rejectionReason =
        role === null ? "unknown workspace role" : "no write permission";
      expect(sent).toEqual([
        JSON.stringify({
          type: "file-reject",
          transferId: 12,
          reason: rejectionReason,
        }),
      ]);
      expect(transferStates).toEqual([`rejected:${rejectionReason}`]);
    },
  );
});
