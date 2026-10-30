import { create } from "zustand";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

type SignalState = {
  status: ConnectionStatus;
  roundTripMs: number | null;
  setStatus: (status: ConnectionStatus) => void;
  setRoundTripMs: (roundTripMs: number | null) => void;
};

export const useSignalStore = create<SignalState>((set) => ({
  status: "connecting",
  roundTripMs: null,
  setStatus: (status) => set({ status }),
  setRoundTripMs: (roundTripMs) => set({ roundTripMs }),
}));
