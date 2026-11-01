import { create } from "zustand";
import type { ChatMessage } from "@zerocloud/shared";
import type { PeerManagerEvents, PeerSnapshot } from "./webrtc/PeerManager";
import type { IncomingOffer, TransferSnapshot } from "./transfer/types";

export type ChatEntry = {
  id: string;
  peerId: string;
  message: ChatMessage;
  direction: "sent" | "received";
};

export type SessionEvent = PeerManagerEvents["log"] & {
  id: string;
};

type PeerState = {
  peerId: string | null;
  activeRoomId: string | null;
  isJoined: boolean;
  peers: Record<string, PeerSnapshot>;
  messages: ChatEntry[];
  events: SessionEvent[];
  lastError: string | null;
  transfers: TransferSnapshot[];
  incomingOffers: IncomingOffer[];
  setPeerId: (peerId: string) => void;
  setActiveRoom: (roomId: string | null) => void;
  setJoined: (isJoined: boolean) => void;
  setPeer: (peer: PeerSnapshot) => void;
  removePeer: (peerId: string) => void;
  clearPeers: () => void;
  addMessage: (entry: ChatEntry) => void;
  addEvent: (event: PeerManagerEvents["log"]) => void;
  setError: (message: string | null) => void;
  setTransfer: (transfer: TransferSnapshot) => void;
  addIncomingOffer: (offer: IncomingOffer) => void;
  removeIncomingOffer: (peerId: string, transferId: number) => void;
  clearTransferBlob: (key: string) => void;
  resetSession: () => void;
};

const initialSession = {
  activeRoomId: null,
  isJoined: false,
  peers: {} as Record<string, PeerSnapshot>,
  messages: [] as ChatEntry[],
  events: [] as SessionEvent[],
  lastError: null as string | null,
  transfers: [] as TransferSnapshot[],
  incomingOffers: [] as IncomingOffer[],
};

export const usePeerStore = create<PeerState>((set) => ({
  peerId: null,
  ...initialSession,
  setPeerId: (peerId) => set({ peerId }),
  setActiveRoom: (activeRoomId) => set({ activeRoomId }),
  setJoined: (isJoined) => set({ isJoined }),
  setPeer: (peer) =>
    set((state) => ({ peers: { ...state.peers, [peer.peerId]: peer } })),
  removePeer: (peerId) =>
    set((state) => {
      const peers = { ...state.peers };
      delete peers[peerId];
      return { peers };
    }),
  clearPeers: () => set({ peers: {} }),
  addMessage: (entry) =>
    set((state) => ({ messages: [...state.messages, entry] })),
  addEvent: (event) =>
    set((state) => ({
      events: [...state.events, { ...event, id: crypto.randomUUID() }].slice(
        -100,
      ),
    })),
  setError: (lastError) => set({ lastError }),
  setTransfer: (transfer) =>
    set((state) => ({
      transfers: [
        ...state.transfers.filter((entry) => entry.key !== transfer.key),
        transfer,
      ],
    })),
  addIncomingOffer: (offer) =>
    set((state) => ({
      incomingOffers: state.incomingOffers.some(
        (entry) =>
          entry.peerId === offer.peerId &&
          entry.transferId === offer.transferId,
      )
        ? state.incomingOffers
        : [...state.incomingOffers, offer],
    })),
  removeIncomingOffer: (peerId, transferId) =>
    set((state) => ({
      incomingOffers: state.incomingOffers.filter(
        (entry) => entry.peerId !== peerId || entry.transferId !== transferId,
      ),
    })),
  clearTransferBlob: (key) =>
    set((state) => ({
      transfers: state.transfers.map((transfer) => {
        if (transfer.key !== key) return transfer;
        const updated = { ...transfer };
        delete updated.blob;
        return updated;
      }),
    })),
  resetSession: () => set({ ...initialSession }),
}));
