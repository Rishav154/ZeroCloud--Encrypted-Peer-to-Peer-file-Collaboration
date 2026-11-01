import type { FileOfferPayload } from "@zerocloud/shared";

export type PullOfferExpectation = {
  requestId: string;
  size: number;
  sha256: string;
};

export function classifyPullOffer(
  offer: Pick<FileOfferPayload, "purpose" | "requestId" | "size" | "sha256">,
  expectation: PullOfferExpectation | undefined,
): "manual" | "reject" | "auto-accept" {
  if (offer.purpose !== "sync" || !expectation) return "manual";
  if (offer.requestId !== expectation.requestId) return "manual";
  if (offer.size !== expectation.size || offer.sha256 !== expectation.sha256) {
    return "reject";
  }
  return "auto-accept";
}
