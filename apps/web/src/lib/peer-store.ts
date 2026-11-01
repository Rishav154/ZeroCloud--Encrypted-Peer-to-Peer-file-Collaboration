import { create } from "zustand";
import type { ChatMessage, WorkspaceMemberDirectory } from "@zerocloud/shared";
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
  activeWorkspaceId: string | null;
  isJoined: boolean;
  peers: Record<string, PeerSnapshot>;
  members: Record<string, WorkspaceMemberDirectory>;
  removedMemberIds: Record<string, true>;
  messages: ChatEntry[];
  events: SessionEvent[];
  lastError: string | null;
  transfers: TransferSnapshot[];
  incomingOffers: IncomingOffer[];
  setPeerId: (peerId: string) => void;
  setActiveWorkspace: (workspaceId: string | null) => void;
  setJoined: (isJoined: boolean) => void;
  setPeer: (peer: PeerSnapshot) => void;
  removePeer: (peerId: string) => void;
  clearPeers: () => void;
  setMembers: (members: WorkspaceMemberDirectory[]) => void;
  setMember: (member: WorkspaceMemberDirectory) => void;
  removeMember: (userId: string) => void;
  setMemberRole: (userId: string, role: "editor" | "viewer") => void;
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
  activeWorkspaceId: null,
  isJoined: false,
  peers: {} as Record<string, PeerSnapshot>,
  members: {} as Record<string, WorkspaceMemberDirectory>,
  removedMemberIds: {} as Record<string, true>,
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
  setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId }),
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
  setMembers: (members) =>
    set({
      members: Object.fromEntries(
        members.map((member) => [member.userId, member]),
      ),
      removedMemberIds: {},
    }),
  setMember: (member) =>
    set((state) => {
      const previous = state.members[member.userId];
      const next = member.publicKey
        ? member
        : { ...member, publicKey: previous?.publicKey ?? "" };
      const removedMemberIds = { ...state.removedMemberIds };
      delete removedMemberIds[member.userId];
      return {
        members: { ...state.members, [member.userId]: next },
        removedMemberIds,
      };
    }),
  removeMember: (userId) =>
    set((state) => {
      const members = { ...state.members };
      delete members[userId];
      return {
        members,
        removedMemberIds: { ...state.removedMemberIds, [userId]: true },
      };
    }),
  setMemberRole: (userId, role) =>
    set((state) => {
      const member = state.members[userId];
      if (!member) return state;
      return { members: { ...state.members, [userId]: { ...member, role } } };
    }),
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
