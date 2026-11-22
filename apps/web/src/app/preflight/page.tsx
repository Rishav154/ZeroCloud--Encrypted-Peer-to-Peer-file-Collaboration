"use client";

import { useCallback, useEffect, useState } from "react";
import { parseServerMessage, generateIdentityKeyPair } from "@zerocloud/shared";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { loadExistingIdentity } from "../../lib/identity/identityStore";
import { useAuthStore } from "../../lib/auth/session";
import { publicConfig } from "../../lib/config";

type CheckStatus = "checking" | "green" | "red" | "amber";
type CheckId = "secure" | "crypto" | "indexeddb" | "health" | "websocket" | "ice" | "identity" | "build";
type CheckResult = { id: CheckId; title: string; status: CheckStatus; detail: string; measuredAt: number };

const titles: Record<CheckId, string> = {
  secure: "Secure context and WebCrypto",
  crypto: "Identity curve support",
  indexeddb: "IndexedDB and local storage",
  health: "Signal API and database",
  websocket: "WebSocket ping/pong",
  ice: "ICE gathering",
  identity: "Browser identity",
  build: "Build information",
};

const initialResults = (): Record<CheckId, CheckResult> => Object.fromEntries(
  (Object.keys(titles) as CheckId[]).map((id) => [id, {
    id, title: titles[id], status: "checking", detail: "Waiting to run", measuredAt: Date.now(),
  }]),
) as Record<CheckId, CheckResult>;

export default function PreflightPage() {
  const hydrate = useAuthStore((state) => state.hydrate);
  const [results, setResults] = useState<Record<CheckId, CheckResult>>(initialResults);
  const [running, setRunning] = useState<Set<CheckId>>(new Set());
  const [copyStatus, setCopyStatus] = useState<string | null>(null);

  useEffect(() => { hydrate(); }, [hydrate]);

  const setResult = useCallback((id: CheckId, status: CheckStatus, detail: string): void => {
    setResults((previous) => ({ ...previous, [id]: { id, title: titles[id], status, detail, measuredAt: Date.now() } }));
  }, []);

  const runCheck = useCallback(async (id: CheckId): Promise<void> => {
    setRunning((previous) => new Set(previous).add(id));
    setResult(id, "checking", "Checking…");
    let wakeTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const task = runCheckTask(id);
      const slow = new Promise<void>((resolve) => {
        wakeTimer = setTimeout(() => {
          setResult(id, "amber", "Waking up the server… retrying automatically");
          resolve();
        }, 3000);
      });
      const result = await Promise.race([
        task,
        slow.then(() => task),
      ]);
      setResult(id, result.status, result.detail);
    } catch (error) {
      setResult(id, "red", error instanceof Error ? error.message : "Check failed");
    } finally {
      if (wakeTimer) clearTimeout(wakeTimer);
      setRunning((previous) => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  }, [setResult]);

  const runAll = useCallback((): void => {
    for (const id of Object.keys(titles) as CheckId[]) void runCheck(id);
  }, [runCheck]);

  useEffect(() => { runAll(); }, [runAll]);

  async function copyReport(): Promise<void> {
    const report = {
      generatedAt: new Date().toISOString(),
      checks: Object.values(results).map(({ id, status, detail }) => ({ id, status, detail })),
      fingerprintShort: results.identity.detail.match(/fingerprint ([a-f0-9]{8})/i)?.[1] ?? null,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopyStatus("Report copied");
    } catch {
      setCopyStatus("Clipboard is unavailable in this browser");
    }
  }

  const summary = Object.values(results).every((check) => check.status === "green")
    ? "All preflight checks are green"
    : "Review amber and red checks before the demo";

  return (
    <main className="min-h-screen bg-zinc-950 px-4 py-10 text-zinc-100">
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.25em] text-violet-300">ZeroCloud</p>
            <h1 className="mt-2 text-3xl font-semibold">Demo preflight</h1>
            <p className="mt-2 text-sm text-zinc-400">{summary}</p>
          </div>
          <div className="flex gap-2">
            <Button onClick={runAll}>Run all</Button>
            <Button variant="outline" onClick={() => void copyReport()}>Copy report</Button>
          </div>
        </header>
        <Card className="border-zinc-800 bg-zinc-900/70">
          <CardHeader><CardTitle>Readiness checks</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {(Object.keys(titles) as CheckId[]).map((id) => {
              const check = results[id];
              return (
                <div key={id} className="flex items-center justify-between gap-4 rounded-lg border border-zinc-800 p-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 rounded-full ${statusColor(check.status)}`} />
                      <h2 className="font-medium">{check.title}</h2>
                    </div>
                    <p className="mt-1 break-words pl-5 text-sm text-zinc-400">{check.detail}</p>
                  </div>
                  <Button variant="outline" disabled={running.has(id)} onClick={() => void runCheck(id)}>
                    {running.has(id) ? "Checking…" : "Re-run"}
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
        {copyStatus && <p role="status" className="text-sm text-zinc-400">{copyStatus}</p>}
      </div>
    </main>
  );
}

async function runCheckTask(id: CheckId): Promise<{ status: CheckStatus; detail: string }> {
  if (id === "secure") {
    const secure = window.isSecureContext && Boolean(globalThis.crypto?.subtle);
    return secure
      ? { status: "green", detail: "Secure context and WebCrypto are available" }
      : { status: "red", detail: "Use HTTPS or localhost; WebCrypto requires a secure context" };
  }
  if (id === "crypto") {
    if (!window.isSecureContext || !globalThis.crypto?.subtle) return { status: "red", detail: "WebCrypto unavailable in this context" };
    const identity = await generateIdentityKeyPair();
    return { status: "green", detail: `${identity.algorithm} is available${identity.algorithm === "P-256" ? " (X25519 fallback)" : ""}` };
  }
  if (id === "indexeddb") return testIndexedDb();
  if (id === "health") return testHealth();
  if (id === "websocket") return testWebSocket();
  if (id === "ice") return testIce();
  if (id === "identity") {
    const identity = await loadExistingIdentity();
    if (!identity) return { status: "amber", detail: "No identity yet" };
    return { status: "green", detail: `${identity.algorithm}; fingerprint ${identity.fingerprint.slice(0, 8)}` };
  }
  const health = await fetchHealthWithRetry();
  const webSha = process.env.NEXT_PUBLIC_BUILD_SHA ?? "local";
  const webTime = process.env.NEXT_PUBLIC_BUILD_TIME ?? "unknown";
  const signalSha = typeof health.build?.sha === "string" ? health.build.sha : "unknown";
  const signalTime = typeof health.build?.time === "string" ? health.build.time : "unknown";
  const status = webSha !== "local" && signalSha !== "unknown" ? "green" : "amber";
  return { status, detail: `Web ${webSha.slice(0, 8)} (${webTime}); signal ${signalSha.slice(0, 8)} (${signalTime})` };
}

async function testIndexedDb(): Promise<{ status: CheckStatus; detail: string }> {
  if (!("indexedDB" in window)) return { status: "red", detail: "IndexedDB is unavailable" };
  const databaseName = `zc-preflight-${crypto.randomUUID()}`;
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const open = indexedDB.open(databaseName, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("check");
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error ?? new Error("IndexedDB open failed"));
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction("check", "readwrite");
    const store = transaction.objectStore("check");
    store.put("ok", "probe");
    const read = store.get("probe");
    read.onsuccess = () => {
      if (read.result !== "ok") {
        transaction.abort();
        reject(new Error("IndexedDB read verification failed"));
        return;
      }
      store.delete("probe");
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
  database.close();
  await new Promise<void>((resolve, reject) => {
    const deletion = indexedDB.deleteDatabase(databaseName);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => reject(deletion.error ?? new Error("IndexedDB cleanup failed"));
  });
  const estimate = await navigator.storage?.estimate().catch(() => undefined);
  if (!estimate) return { status: "amber", detail: "IndexedDB read/write/delete passed; storage quota estimate unavailable" };
  const used = estimate.usage ?? 0;
  const quota = estimate.quota ?? 0;
  const percent = quota ? Math.round((used / quota) * 100) : 0;
  return { status: "green", detail: `IndexedDB write/read/delete passed; storage ${percent}% used (${formatBytes(used)} of ${formatBytes(quota)})` };
}

type HealthPayload = {
  db?: unknown;
  build?: { sha?: unknown; time?: unknown };
};

async function fetchHealthWithRetry(): Promise<HealthPayload> {
  const origin = new URL(publicConfig.NEXT_PUBLIC_API_URL).origin;
  const deadline = Date.now() + 25_000;
  let lastError = "Signal health request failed";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`, { cache: "no-store", signal: AbortSignal.timeout(7000) });
      const body: unknown = await response.json();
      if (!body || typeof body !== "object") throw new Error("Health response was invalid");
      const value = body as HealthPayload;
      if (value.db === "up") return value;
      if (value.db === "waking") lastError = "Database is waking up";
      else if (value.db === "down") return value;
      else if (!response.ok) lastError = "Signal health request failed";
      else return value;
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
    }
    await sleep(1000);
  }
  throw new Error(lastError);
}

async function testHealth(): Promise<{ status: CheckStatus; detail: string }> {
  const started = performance.now();
  const health = await fetchHealthWithRetry();
  const latency = Math.round(performance.now() - started);
  const db = health.db;
  const dbStatus = db === "up" ? "green" : db === "waking" ? "amber" : "red";
  const state = db === "up" ? "database up" : `database ${String(db)}`;
  return { status: dbStatus, detail: `/health ${latency} ms; ${state}` };
}

async function testWebSocket(): Promise<{ status: CheckStatus; detail: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const latency = await pingWebSocket();
      return { status: "green", detail: `Ping/pong ${latency} ms` };
    } catch (error) {
      lastError = error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("WebSocket ping failed");
}

function pingWebSocket(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(publicConfig.NEXT_PUBLIC_SIGNAL_URL);
    const timestamp = Date.now();
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("WebSocket ping timed out")), 10_000);
    function finish(error?: Error, latency?: number): void {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error) reject(error);
      else resolve(latency ?? 0);
    }
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "ping", ts: timestamp })));
    socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data !== "string") return;
      const parsed = parseServerMessage(event.data);
      if (parsed.success && parsed.data.type === "pong" && parsed.data.ts === timestamp) {
        finish(undefined, Math.round(performance.now() - started));
      }
    });
    socket.addEventListener("error", () => finish(new Error("Could not connect to the signalling WebSocket")));
    socket.addEventListener("close", () => { if (!settled) finish(new Error("WebSocket closed before pong")); });
    const started = performance.now();
  });
}

async function testIce(): Promise<{ status: CheckStatus; detail: string }> {
  const iceServers: RTCIceServer[] = publicConfig.NEXT_PUBLIC_STUN_URLS
    .split(",").map((urls) => urls.trim()).filter(Boolean).map((urls) => ({ urls }));
  const turnUrls = publicConfig.NEXT_PUBLIC_TURN_URL.split(",").map((url) => url.trim()).filter(Boolean);
  if (turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      ...(publicConfig.NEXT_PUBLIC_TURN_USERNAME ? { username: publicConfig.NEXT_PUBLIC_TURN_USERNAME } : {}),
      ...(publicConfig.NEXT_PUBLIC_TURN_CREDENTIAL ? { credential: publicConfig.NEXT_PUBLIC_TURN_CREDENTIAL } : {}),
    });
  }
  const connection = new RTCPeerConnection({
    iceServers,
    ...(publicConfig.NEXT_PUBLIC_FORCE_RELAY === "true" ? { iceTransportPolicy: "relay" as const } : {}),
  });
  const candidates = new Set<RTCIceCandidateType>();
  connection.createDataChannel("preflight");
  const gathered = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    connection.addEventListener("icecandidate", (event) => {
      if (event.candidate?.type) candidates.add(event.candidate.type);
      if (!event.candidate) { clearTimeout(timer); resolve(); }
    });
  });
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await gathered;
  connection.close();
  const shown = ["host", "srflx", "relay"].filter((value) => candidates.has(value as RTCIceCandidateType));
  if (!candidates.has("srflx") && !candidates.has("relay")) return { status: "red", detail: `No server-reflexive or relay candidate; gathered ${shown.join(", ") || "none"}` };
  if (!candidates.has("relay")) return { status: "amber", detail: `Gathered ${shown.join(", ")}; no relay candidate` };
  return { status: "green", detail: `Gathered ${shown.join(", ")}; relay is available` };
}

function statusColor(status: CheckStatus): string {
  if (status === "green") return "bg-emerald-400";
  if (status === "red") return "bg-rose-400";
  if (status === "amber") return "bg-amber-400 animate-pulse";
  return "bg-zinc-500 animate-pulse";
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
