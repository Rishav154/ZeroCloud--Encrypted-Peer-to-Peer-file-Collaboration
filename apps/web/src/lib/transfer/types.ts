import type { FileOfferPayload } from "@zerocloud/shared";

export type TransferState =
  | "preparing"
  | "waiting"
  | "sending"
  | "receiving"
  | "verifying"
  | "done"
  | "rejected"
  | "failed"
  | "cancelled";
export type TransferSnapshot = {
  key: string;
  transferId: number;
  peerId: string;
  direction: "outgoing" | "incoming";
  name: string;
  size: number;
  state: TransferState;
  progress: number;
  speed: number;
  eta: number | null;
  error?: string;
  blob?: Blob;
};
export type IncomingOffer = {
  peerId: string;
  transferId: number;
  metadata: Omit<FileOfferPayload, "fileKey">;
};
