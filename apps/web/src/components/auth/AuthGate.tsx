"use client";

import { useEffect, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useAuthStore } from "../../lib/auth/session";

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const ready = useAuthStore((state) => state.ready);
  const accessToken = useAuthStore((state) => state.accessToken);
  const hydrate = useAuthStore((state) => state.hydrate);

  useEffect(() => {
    if (!ready) hydrate();
  }, [hydrate, ready]);

  useEffect(() => {
    if (ready && !accessToken) router.replace("/login");
  }, [accessToken, ready, router]);

  if (!ready || !accessToken) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-16 text-zinc-400">
        Loading account…
      </main>
    );
  }
  return children;
}
