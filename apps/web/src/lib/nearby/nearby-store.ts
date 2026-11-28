import { create } from "zustand";
import type { NearbyControlPayload, NearbyPeer } from "@zerocloud/shared";
import type { NearbySnapshot } from "./NearbyManager";
import type { TransferSnapshot } from "../transfer/types";

export type NearbyOffer = { peerId: string; transferId: number; alias: string; fingerprint: string; metadata: { name: string; size: number; mime: string; sha256: string; chunkSize: number; totalChunks: number }; state: "pending" | "receiving" | "done" | "rejected" | "failed" | "cancelled"; error?: string; blob?: Blob };
export type NearbyInviteCard = Omit<Extract<NearbyControlPayload, { type: "workspace-invite" }>, "secret"> & { peerId: string; alias: string; fingerprint: string; verified: boolean };
export type NearbyInviteStatus = { inviteId: string; workspaceId: string; peerId: string; alias: string; workspaceName: string; role: "editor" | "viewer"; expiresAt: string; status: "sent" | "accepted" | "declined" | "expired" };
export type NearbyTextCard = { id: string; peerId: string; alias: string; fingerprint: string; text: string };

type State = { enabled: boolean; peers: Record<string, NearbySnapshot>; groupId: string | null; dropped: number; offers: NearbyOffer[]; transfers: TransferSnapshot[]; texts: NearbyTextCard[]; inviteCards: NearbyInviteCard[]; inviteStatuses: NearbyInviteStatus[]; blocked: string[]; setEnabled: (enabled: boolean) => void; setPeers: (peers: NearbyPeer[]) => void; setPeer: (peer: NearbySnapshot) => void; removePeer: (peerId: string) => void; setGroupId: (id: string | null) => void; countDrop: () => void; setOffer: (offer: NearbyOffer) => void; removeOffer: (peerId: string, transferId: number) => void; addText: (text: NearbyTextCard) => void; removeText: (id: string) => void; setInviteCard: (invite: NearbyInviteCard) => void; removeInviteCard: (inviteId: string) => void; setInviteStatus: (invite: NearbyInviteStatus) => void; setBlocked: (fingerprints: string[]) => void; setTransfer: (transfer: TransferSnapshot) => void; reset: (preserveInvites?: boolean) => void };
export const useNearbyStore = create<State>((set) => ({
  enabled: false, peers: {}, groupId: null, dropped: 0, offers: [], transfers: [], texts: [], inviteCards: [], inviteStatuses: [], blocked: [],
  setEnabled: (enabled) => set({ enabled }),
  setPeers: (peers) => set((state) => ({ peers: Object.fromEntries(peers.map((peer) => [peer.peerId, state.peers[peer.peerId] ?? { ...peer, state: "discovered", error: null }])) })),
  setPeer: (peer) => set((state) => ({ peers: { ...state.peers, [peer.peerId]: peer } })),
  removePeer: (peerId) => set((state) => { const peers = { ...state.peers }; delete peers[peerId]; return { peers }; }),
  setGroupId: (groupId) => set({ groupId }), countDrop: () => set((state) => ({ dropped: state.dropped + 1 })),
  setOffer: (offer) => set((state) => ({ offers: [...state.offers.filter((item) => item.peerId !== offer.peerId || item.transferId !== offer.transferId), offer] })),
  removeOffer: (peerId, transferId) => set((state) => ({ offers: state.offers.filter((item) => item.peerId !== peerId || item.transferId !== transferId) })),
  addText: (text) => set((state) => ({ texts: [...state.texts, text] })),
  removeText: (id) => set((state) => ({ texts: state.texts.filter((item) => item.id !== id) })),
  setInviteCard: (invite) => set((state) => ({ inviteCards: [...state.inviteCards.filter((item) => item.inviteId !== invite.inviteId), invite] })),
  removeInviteCard: (inviteId) => set((state) => ({ inviteCards: state.inviteCards.filter((item) => item.inviteId !== inviteId) })),
  setInviteStatus: (invite) => set((state) => ({ inviteStatuses: [...state.inviteStatuses.filter((item) => item.inviteId !== invite.inviteId), invite] })),
  setBlocked: (blocked) => set({ blocked }),
  setTransfer: (transfer) => set((state) => ({ transfers: [...state.transfers.filter((item) => item.key !== transfer.key), transfer], offers: state.offers.map((item) => item.peerId === transfer.peerId && item.transferId === transfer.transferId ? { ...item, state: transfer.state === "done" ? "done" : transfer.state === "receiving" ? "receiving" : transfer.state === "failed" ? "failed" : transfer.state === "rejected" ? "rejected" : transfer.state === "cancelled" ? "cancelled" : item.state, ...(transfer.error ? { error: transfer.error } : {}), ...(transfer.blob ? { blob: transfer.blob } : {}) } : item) })),
  reset: (preserveInvites = false) => set((state) => ({ enabled: false, peers: {}, groupId: null, dropped: 0, offers: [], transfers: [], texts: [], inviteCards: preserveInvites ? state.inviteCards : [], inviteStatuses: preserveInvites ? state.inviteStatuses : [] })),
}));
