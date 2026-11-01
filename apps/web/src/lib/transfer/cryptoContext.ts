import { buildAad } from "@zerocloud/shared";

export type PeerCryptoContext = {
  sessionKey: CryptoKey;
  localFingerprint: string;
  remoteFingerprint: string;
  localNonce: Uint8Array;
  remoteNonce: Uint8Array;
};

export function localToRemoteAad(
  context: PeerCryptoContext,
  messageContext: string,
  transferId?: number,
): Uint8Array {
  return buildAad({
    context: messageContext,
    senderFingerprint: context.localFingerprint,
    receiverFingerprint: context.remoteFingerprint,
    senderNonce: context.localNonce,
    receiverNonce: context.remoteNonce,
    ...(transferId === undefined ? {} : { transferId }),
  });
}

export function remoteToLocalAad(
  context: PeerCryptoContext,
  messageContext: string,
  transferId?: number,
): Uint8Array {
  return buildAad({
    context: messageContext,
    senderFingerprint: context.remoteFingerprint,
    receiverFingerprint: context.localFingerprint,
    senderNonce: context.remoteNonce,
    receiverNonce: context.localNonce,
    ...(transferId === undefined ? {} : { transferId }),
  });
}
