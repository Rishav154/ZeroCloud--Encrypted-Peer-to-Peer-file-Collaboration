import { create } from "zustand";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

type SignalState = {
  status: ConnectionStatus;
  setStatus: (status: ConnectionStatus) => void;
};

export const useSignalStore = create<SignalState>((set) => ({
  status: "connecting",
  setStatus: (status) => set({ status }),
}));
