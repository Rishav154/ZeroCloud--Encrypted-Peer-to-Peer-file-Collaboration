"use client";

import { useSignalSocket } from "../hooks/use-signal-socket";
import { useSignalStore } from "../lib/signal-store";
import { Button } from "../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";

const statusStyles = {
  connecting: "bg-amber-400",
  connected: "bg-emerald-400",
  disconnected: "bg-rose-400",
};

export default function HomePage() {
  const { sendPing } = useSignalSocket();
  const status = useSignalStore((state) => state.status);
  const roundTripMs = useSignalStore((state) => state.roundTripMs);

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-12">
      <div className="w-full max-w-lg">
        <div className="mb-7 text-center">
          <div className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-violet-300">
            Phase 1 · Foundation
          </div>
          <h1 className="text-3xl font-semibold tracking-tight">ZeroCloud</h1>
          <p className="mt-2 text-sm text-zinc-400">
            Signalling connection check
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Connection</CardTitle>
            <CardDescription>Browser to signalling server</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="mb-6 flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950/70 px-4 py-3">
              <span className="text-sm text-zinc-400">Signalling server</span>
              <span className="flex items-center gap-2 text-sm font-medium capitalize">
                <span
                  className={`h-2 w-2 rounded-full ${statusStyles[status]}`}
                />
                {status}
              </span>
            </div>
            <Button
              className="w-full"
              onClick={sendPing}
              disabled={status !== "connected"}
            >
              Send ping
            </Button>
            <div className="mt-5 flex items-baseline justify-between border-t border-zinc-800 pt-4">
              <span className="text-sm text-zinc-400">Round-trip time</span>
              <span className="font-mono text-sm tabular-nums text-zinc-100">
                {roundTripMs === null ? "—" : `${roundTripMs} ms`}
              </span>
            </div>
          </CardContent>
        </Card>
        <p className="mt-5 text-center text-xs text-zinc-600">
          No file data or keys pass through the signalling server.
        </p>
      </div>
    </main>
  );
}
