import { create } from "zustand";

export type PeerSyncStatus = "syncing" | "in-sync" | "offline" | "error";
export type FileSyncStatus = "queued" | "pulling" | "failed" | "synced";
export type FileSyncSnapshot = {
  status: FileSyncStatus;
  progress: number;
  error?: string;
};

type SyncState = {
  workspaceId: string | null;
  peers: Record<string, PeerSyncStatus>;
  files: Record<string, FileSyncSnapshot>;
  stateHash: string | null;
  setWorkspace: (workspaceId: string | null) => void;
  setPeer: (peerId: string, status: PeerSyncStatus) => void;
  removePeer: (peerId: string) => void;
  setFile: (fileId: string, snapshot: FileSyncSnapshot | null) => void;
  setStateHash: (stateHash: string | null) => void;
  reset: () => void;
};

const emptySync = {
  workspaceId: null,
  peers: {} as Record<string, PeerSyncStatus>,
  files: {} as Record<string, FileSyncSnapshot>,
  stateHash: null as string | null,
};

export const useSyncStore = create<SyncState>((set) => ({
  ...emptySync,
  setWorkspace: (workspaceId) => set({ ...emptySync, workspaceId }),
  setPeer: (peerId, status) =>
    set((state) => ({ peers: { ...state.peers, [peerId]: status } })),
  removePeer: (peerId) =>
    set((state) => {
      const peers = { ...state.peers };
      delete peers[peerId];
      return { peers };
    }),
  setFile: (fileId, snapshot) =>
    set((state) => {
      const files = { ...state.files };
      if (snapshot) files[fileId] = snapshot;
      else delete files[fileId];
      return { files };
    }),
  setStateHash: (stateHash) => set({ stateHash }),
  reset: () => set(emptySync),
}));
