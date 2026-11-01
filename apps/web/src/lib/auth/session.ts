import { create } from "zustand";
import { z } from "zod";
import { workspaceKeyring } from "../workspaces/keyring";

export const sessionUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string().email(),
  displayName: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  keyAlg: z.enum(["X25519", "P-256"]),
});

export type SessionUser = z.infer<typeof sessionUserSchema>;
export type AuthSession = { accessToken: string; user: SessionUser };

const storedSessionSchema = z.object({
  accessToken: z.string().min(1),
  user: sessionUserSchema,
});

type AuthState = {
  accessToken: string | null;
  user: SessionUser | null;
  ready: boolean;
  hydrate: () => void;
  setSession: (session: AuthSession) => void;
  clearSession: () => void;
};

const SESSION_KEY = "zerocloud.session";

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  ready: false,
  hydrate: () => {
    if (typeof window === "undefined") return;
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      const parsed = raw
        ? storedSessionSchema.safeParse(JSON.parse(raw))
        : null;
      if (parsed?.success) {
        set({ ...parsed.data, ready: true });
      } else {
        sessionStorage.removeItem(SESSION_KEY);
        set({ accessToken: null, user: null, ready: true });
      }
    } catch {
      sessionStorage.removeItem(SESSION_KEY);
      set({ accessToken: null, user: null, ready: true });
    }
  },
  setSession: (session) => {
    workspaceKeyring.clearAll();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    set({ ...session, ready: true });
  },
  clearSession: () => {
    workspaceKeyring.clearAll();
    sessionStorage.removeItem(SESSION_KEY);
    set({ accessToken: null, user: null, ready: true });
  },
}));
