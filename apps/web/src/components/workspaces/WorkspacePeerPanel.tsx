"use client";

import { useState, type DragEvent, type FormEvent } from "react";
import { MAX_FILE_SIZE, formatFingerprint } from "@zerocloud/shared";
import { usePeerSession } from "../../hooks/use-peer-session";
import { usePeerStore } from "../../lib/peer-store";
import { useSignalStore } from "../../lib/signal-store";
import { useSyncStore } from "../../lib/sync/sync-store";
import { Button } from "../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import type { PeerSnapshot } from "../../lib/webrtc/PeerManager";

const signalStatusStyles = {
  connecting: "bg-amber-400",
  connected: "bg-emerald-400",
  disconnected: "bg-rose-400",
} as const;

const connectionColors: Record<string, string> = {
  connected: "text-emerald-300",
  connecting: "text-amber-300",
  new: "text-zinc-400",
  disconnected: "text-zinc-500",
  failed: "text-rose-300",
  closed: "text-zinc-600",
};

function shortId(peerId: string): string {
  return peerId.slice(0, 8);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSpeed(bytesPerSecond: number): string {
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB/s`;
}

function groupedFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(" ") ?? fingerprint;
}

export default function WorkspacePeerPanel({
  workspaceId,
  role,
}: {
  workspaceId: string;
  role: "owner" | "editor" | "viewer";
}) {
  const {
    peerId,
    activeWorkspaceId,
    isJoined,
    joinWorkspace,
    leaveWorkspace,
    sendChat,
    sendFile,
    acceptTransfer,
    declineTransfer,
    cancelTransfer,
    identity,
    identityError,
    resetIdentity,
    verifyPeer,
  } = usePeerSession(workspaceId, role);
  const signalStatus = useSignalStore((state) => state.status);
  const syncPeerStatuses = useSyncStore((state) => state.peers);
  const syncStateHash = useSyncStore((state) => state.stateHash);
  const peersById = usePeerStore((state) => state.peers);
  const peers = Object.values(peersById);
  const verifiedPeers = peers.filter((peer) => peer.workspaceState === "verified");
  const messages = usePeerStore((state) => state.messages);
  const events = usePeerStore((state) => state.events);
  const lastError = usePeerStore((state) => state.lastError);
  const transfers = usePeerStore((state) => state.transfers);
  const incomingOffers = usePeerStore((state) => state.incomingOffers);
  const [chatText, setChatText] = useState("");
  const [copied, setCopied] = useState(false);
  const [fileTarget, setFileTarget] = useState("all");
  const [dragActive, setDragActive] = useState(false);
  const [peerToVerify, setPeerToVerify] = useState<PeerSnapshot | null>(null);
  const [identityCopied, setIdentityCopied] = useState(false);

  const copyPeerId = async (): Promise<void> => {
    if (!peerId) return;
    try {
      await navigator.clipboard.writeText(peerId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      usePeerStore.getState().setError("Could not copy peer ID");
    }
  };

  const submitChat = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (sendChat(chatText)) setChatText("");
  };

  const queueFiles = (files: FileList | File[]): void => {
    if (role === "viewer") return;
    for (const file of Array.from(files)) {
      if (file.size > MAX_FILE_SIZE) {
        usePeerStore
          .getState()
          .setError(`${file.name} exceeds the 500 MB limit`);
        continue;
      }
      sendFile(file, fileTarget);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragActive(false);
    queueFiles(event.dataTransfer.files);
  };

  const downloadTransfer = (key: string, name: string, blob?: Blob): void => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    usePeerStore.getState().clearTransferBlob(key);
  };

  const copyText = async (
    value: string,
    identityCopy = false,
  ): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      if (identityCopy) {
        setIdentityCopied(true);
        window.setTimeout(() => setIdentityCopied(false), 1500);
      }
    } catch {
      usePeerStore
        .getState()
        .setError("Could not copy fingerprint to clipboard");
    }
  };

  const confirmResetIdentity = async (): Promise<void> => {
    if (
      !window.confirm(
        "Reset this browser identity? This permanently locks this account out of its workspaces because there is no key recovery in this phase. The current workspace will be left, and peers will need to verify the new fingerprint.",
      )
    )
      return;
    await resetIdentity();
  };

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 sm:py-12">
      <div className="mx-auto w-full max-w-5xl">
        <header className="mb-7 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.28em] text-violet-300">
              ZeroCloud · Workspace
            </div>
            <h1 className="text-3xl font-semibold tracking-tight">
              Peer connection
            </h1>
            <p className="mt-2 text-sm text-zinc-400">
              Peer chat and file transfer over browser DataChannels
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
            <span
              className={`h-2 w-2 rounded-full ${signalStatusStyles[signalStatus]}`}
            />
            <span className="text-zinc-300">Signalling {signalStatus}</span>
          </div>
        </header>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
          <div className="space-y-5">
            <Card>
              <CardHeader>
                <CardTitle>My identity</CardTitle>
                <CardDescription>
                  Private key stays in this browser profile.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {identity ? (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-zinc-500">
                        {identity.algorithm}
                      </p>
                      <p className="mt-1 font-mono text-sm tracking-wide text-zinc-200">
                        {formatFingerprint(identity.fingerprint)}
                      </p>
                    </div>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        className="px-3 py-1.5 text-xs"
                        onClick={() =>
                          void copyText(identity.fingerprint, true)
                        }
                      >
                        {identityCopied ? "Copied" : "Copy fingerprint"}
                      </Button>
                      <Button
                        variant="outline"
                        className="px-3 py-1.5 text-xs"
                        onClick={() => void confirmResetIdentity()}
                      >
                        Reset identity
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p
                    className={`text-sm ${identityError ? "text-rose-300" : "text-zinc-500"}`}
                  >
                    {identityError ?? "Preparing browser identity…"}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Workspace connection</CardTitle>
                <CardDescription>
                  Join this workspace to connect to its online members.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                  <div className="self-center text-sm text-zinc-300">
                    Workspace room ·{" "}
                    {activeWorkspaceId ? "joined" : "not joined"}
                  </div>
                  <div className="flex items-end">
                    {activeWorkspaceId ? (
                      <Button
                        className="w-full sm:w-auto"
                        variant="outline"
                        onClick={leaveWorkspace}
                      >
                        Leave workspace
                      </Button>
                    ) : (
                      <Button
                        className="w-full sm:w-auto"
                        onClick={joinWorkspace}
                        disabled={!peerId || signalStatus === "disconnected"}
                      >
                        Join workspace
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800 pt-4">
                  <div className="text-xs text-zinc-500">
                    Your peer ID{" "}
                    <span className="ml-2 font-mono text-zinc-300">
                      {peerId ? shortId(peerId) : "creating…"}
                    </span>
                  </div>
                  <Button
                    variant="outline"
                    className="px-3 py-1.5 text-xs"
                    onClick={() => void copyPeerId()}
                    disabled={!peerId}
                  >
                    {copied ? "Copied" : "Copy ID"}
                  </Button>
                </div>
                {lastError && (
                  <div
                    role="alert"
                    className="mt-4 rounded-lg border border-rose-900/70 bg-rose-950/40 px-3 py-2 text-sm text-rose-200"
                  >
                    {lastError}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <CardTitle>Peers</CardTitle>
                    <CardDescription>
                      {activeWorkspaceId
                        ? "Workspace peers"
                        : "Join to discover peers"}
                    </CardDescription>
                  </div>
                  <span className="rounded-full border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400">
                    {peers.length}/7 peers
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                {peers.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-zinc-800 px-4 py-8 text-center text-sm text-zinc-500">
                    {activeWorkspaceId
                      ? "Waiting for peers…"
                      : "No workspace joined"}
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {peers.map((peer) => {
                      const route =
                        peer.candidateType === "relay"
                          ? "relayed"
                          : peer.candidateType
                            ? "direct"
                            : "checking";
                      return (
                        <li
                          key={peer.peerId}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/70 px-3 py-3"
                        >
                          <div className="min-w-0">
                            <div className="font-mono text-sm text-zinc-200">
                              {shortId(peer.peerId)}
                            </div>
                            <div
                              className={`mt-1 text-xs ${connectionColors[peer.connectionState] ?? "text-zinc-400"}`}
                            >
                              {peer.failed ? "failed" : peer.connectionState} ·
                              ICE {peer.iceConnectionState}
                            </div>
                            <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                              <span
                                className={`rounded-full px-2 py-0.5 ${peer.handshakeState === "secure" ? "bg-emerald-950 text-emerald-200" : peer.handshakeState === "incompatible" || peer.handshakeState === "identity-mismatch" || peer.handshakeState === "failed" ? "bg-rose-950 text-rose-200" : "bg-amber-950 text-amber-200"}`}
                              >
                                {peer.handshakeState.replace("-", " ")}
                              </span>
                              {peer.algorithm && (
                                <span className="text-zinc-500">
                                  {peer.algorithm}
                                </span>
                              )}
                              {peer.fingerprint && (
                                <span className="font-mono text-zinc-400">
                                  {formatFingerprint(peer.fingerprint)}
                                </span>
                              )}
                              {peer.sameIdentity && (
                                <span className="rounded-full bg-sky-950 px-2 py-0.5 text-sky-200">
                                  same identity as this device
                                </span>
                              )}
                              {peer.handshakeState === "secure" && (
                                <span
                                  className={`rounded-full px-2 py-0.5 ${peer.verified ? "bg-emerald-950 text-emerald-200" : "bg-yellow-950 text-yellow-200"}`}
                                >
                                  {peer.verified ? "Verified" : "Unverified"}
                                </span>
                              )}
                              <span className={`rounded-full px-2 py-0.5 ${peer.workspaceState === "verified" ? "bg-emerald-950 text-emerald-200" : peer.workspaceState === "no-access" ? "bg-rose-950 text-rose-200" : "bg-amber-950 text-amber-200"}`}>
                                {peer.workspaceState === "verified" ? `Workspace verified · v${peer.workspaceVerifiedVersion}` : peer.workspaceState === "waiting-for-key" ? "waiting for key" : peer.workspaceState === "no-access" ? "no workspace access" : peer.workspaceState === "verifying" ? "verifying workspace key" : "workspace unverified"}
                              </span>
                              {peer.workspaceState === "verified" && (
                                <span
                                  className={`rounded-full px-2 py-0.5 ${syncPeerStatuses[peer.peerId] === "in-sync" ? "bg-emerald-950 text-emerald-200" : syncPeerStatuses[peer.peerId] === "error" ? "bg-rose-950 text-rose-200" : "bg-amber-950 text-amber-200"}`}
                                >
                                  {syncPeerStatuses[peer.peerId] ?? "syncing"}
                                </span>
                              )}
                              {peer.handshakeState === "secure" &&
                                peer.fingerprint && (
                                  <Button
                                    variant="outline"
                                    className="px-2 py-0.5 text-[11px]"
                                    onClick={() => setPeerToVerify(peer)}
                                  >
                                    {peer.verified
                                      ? "View fingerprints"
                                      : "Verify"}
                                  </Button>
                                )}
                            </div>
                            {peer.handshakeError && (
                              <p className="mt-1 text-xs text-rose-300">
                                {peer.handshakeError}
                              </p>
                            )}
                          </div>
                          <div className="flex items-center gap-2 text-xs">
                            <span
                              className={`rounded-full px-2.5 py-1 ${route === "relayed" ? "bg-orange-950 text-orange-200" : route === "direct" ? "bg-emerald-950 text-emerald-200" : "bg-zinc-800 text-zinc-400"}`}
                            >
                              {route}
                              {peer.candidateType
                                ? ` · ${peer.candidateType}`
                                : ""}
                            </span>
                            <span className="rounded-full border border-zinc-700 px-2.5 py-1 text-zinc-300">
                              DC {peer.dataChannelState}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="flex min-h-[520px] flex-col">
            <CardHeader>
              <CardTitle>Room chat</CardTitle>
              <CardDescription>
                Messages travel over WebRTC DataChannels.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col">
              <div className="mb-4 flex-1 space-y-3 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/70 p-3">
                {messages.length === 0 ? (
                  <div className="flex h-full min-h-56 items-center justify-center text-center text-sm text-zinc-600">
                    Join a room and connect to a peer to start chatting.
                  </div>
                ) : (
                  messages.map((entry) => (
                    <div
                      key={entry.id}
                      className={`max-w-[90%] rounded-xl px-3 py-2 ${entry.direction === "sent" ? "ml-auto bg-violet-950/70" : "bg-zinc-800/70"}`}
                    >
                      <div className="mb-1 flex items-center justify-between gap-4 text-[11px] text-zinc-400">
                        <span>
                          {entry.direction === "sent"
                            ? "You"
                            : shortId(entry.peerId)}
                        </span>
                        <time>
                          {new Date(entry.message.ts).toLocaleTimeString()}
                        </time>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-sm text-zinc-100">
                        {entry.message.text}
                      </p>
                    </div>
                  ))
                )}
              </div>
              <form onSubmit={submitChat} className="flex gap-2">
                <input
                  value={chatText}
                  onChange={(event) => setChatText(event.target.value)}
                  disabled={!isJoined || verifiedPeers.length === 0}
                  maxLength={4000}
                  className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 outline-none transition placeholder:text-zinc-600 focus:border-violet-400 disabled:opacity-50"
                  placeholder={
                    verifiedPeers.length > 0
                      ? "Write a message…"
                      : "Waiting for a connected peer…"
                  }
                />
                <Button
                  type="submit"
                  disabled={
                    !chatText.trim() || !isJoined || verifiedPeers.length === 0
                  }
                >
                  Send
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        <Card className="mt-5">
          <CardHeader>
            <CardTitle>Transfers</CardTitle>
            <CardDescription>
              Files travel directly over the peer DataChannel.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            {role === "viewer" ? (
              <p className="rounded-lg border border-zinc-800 px-3 py-2 text-sm text-zinc-400">
                Viewer access can receive files but cannot send them.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="min-w-48 flex-1 space-y-2 text-xs font-medium text-zinc-400">
                    Send to
                    <select
                      value={fileTarget}
                      onChange={(event) => setFileTarget(event.target.value)}
                      disabled={!isJoined}
                      className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100"
                    >
                      <option value="all">Send to all connected peers</option>
                      {peers
                        .filter(
                          (peer) =>
                            peer.dataChannelState === "open" &&
                            peer.handshakeState === "secure" &&
                            peer.workspaceState === "verified",
                        )
                        .map((peer) => (
                          <option key={peer.peerId} value={peer.peerId}>
                            {shortId(peer.peerId)}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="cursor-pointer rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-200 hover:border-violet-400">
                    Choose files
                    <input
                      type="file"
                      multiple
                      className="sr-only"
                      disabled={
                        !isJoined ||
                        !peers.some(
                          (peer) =>
                            peer.dataChannelState === "open" &&
                            peer.handshakeState === "secure" &&
                            peer.workspaceState === "verified",
                        )
                      }
                      onChange={(event) => {
                        if (event.target.files) queueFiles(event.target.files);
                        event.target.value = "";
                      }}
                    />
                  </label>
                </div>
                <div
                  onDragEnter={(event) => {
                    event.preventDefault();
                    setDragActive(true);
                  }}
                  onDragOver={(event) => event.preventDefault()}
                  onDragLeave={() => setDragActive(false)}
                  onDrop={onDrop}
                  className={`rounded-xl border border-dashed px-4 py-6 text-center text-sm ${dragActive ? "border-violet-400 bg-violet-950/20 text-violet-200" : "border-zinc-700 text-zinc-500"}`}
                >
                  Drop files here · maximum 500 MB per file
                </div>
              </>
            )}

            {incomingOffers.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-zinc-200">
                  Incoming offers
                </h3>
                {incomingOffers.map(
                  ({ peerId: from, transferId, metadata }) => (
                    <div
                      key={`${from}:${transferId}`}
                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-violet-900/60 bg-violet-950/20 p-3"
                    >
                      <div className="min-w-0">
                        <p className="break-all text-sm text-zinc-100">
                          {metadata.name}
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">
                          {formatSize(metadata.size)} · from {shortId(from)}
                        </p>
                        {!peersById[from]?.verified && (
                          <p className="mt-1 text-xs text-yellow-300">
                            Peer not verified
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button
                          onClick={() => acceptTransfer(from, transferId)}
                        >
                          Accept
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => declineTransfer(from, transferId)}
                        >
                          Decline
                        </Button>
                      </div>
                    </div>
                  ),
                )}
              </div>
            )}

            <div className="space-y-2">
              {transfers.length === 0 ? (
                <p className="rounded-xl border border-zinc-800 px-4 py-6 text-center text-sm text-zinc-600">
                  No transfers yet.
                </p>
              ) : (
                transfers.map((transfer) => (
                  <div
                    key={transfer.key}
                    className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="break-all text-sm text-zinc-100">
                          {transfer.direction === "outgoing" ? "↑" : "↓"}{" "}
                          {transfer.name}
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">
                          {shortId(transfer.peerId)} ·{" "}
                          {formatSize(transfer.size)} · {transfer.state}
                          {transfer.error ? ` · ${transfer.error}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        {transfer.direction === "incoming" &&
                          transfer.state === "done" &&
                          transfer.blob && (
                            <Button
                              className="px-3 py-1.5 text-xs"
                              onClick={() =>
                                downloadTransfer(
                                  transfer.key,
                                  transfer.name,
                                  transfer.blob,
                                )
                              }
                            >
                              Download
                            </Button>
                          )}
                        {!["done", "failed", "cancelled", "rejected"].includes(
                          transfer.state,
                        ) && (
                          <Button
                            variant="outline"
                            className="px-3 py-1.5 text-xs"
                            onClick={() =>
                              cancelTransfer(
                                transfer.peerId,
                                transfer.transferId,
                                transfer.direction,
                              )
                            }
                          >
                            Cancel
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                      <div
                        className="h-full rounded-full bg-violet-400 transition-[width]"
                        style={{
                          width: `${Math.max(0, Math.min(100, transfer.progress * 100))}%`,
                        }}
                      />
                    </div>
                    <div className="mt-2 flex justify-between text-[11px] text-zinc-500">
                      <span>
                        {Math.round(transfer.progress * 100)}%
                        {transfer.speed > 0
                          ? ` · ${formatSpeed(transfer.speed)}`
                          : ""}
                      </span>
                      <span>
                        {transfer.eta === null
                          ? ""
                          : `${transfer.eta}s remaining`}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <details className="mt-5 rounded-2xl border border-zinc-800 bg-zinc-900/70">
          <summary className="cursor-pointer px-5 py-4 text-sm font-medium text-zinc-300">
            Debug events{" "}
            <span className="ml-2 text-xs text-zinc-500">{events.length}</span>
          </summary>
          <div className="max-h-56 space-y-1 overflow-y-auto border-t border-zinc-800 px-5 py-3 font-mono text-xs">
            <div className="mb-2 border-b border-zinc-800 pb-2 text-zinc-500">
              Local sync state hash: {syncStateHash ?? "pending"}
            </div>
            {events.length === 0 ? (
              <p className="text-zinc-600">No events yet.</p>
            ) : (
              [...events].reverse().map((event) => (
                <div
                  key={event.id}
                  className={
                    event.level === "error" ? "text-rose-300" : "text-zinc-400"
                  }
                >
                  <time className="mr-2 text-zinc-600">
                    {new Date(event.at).toLocaleTimeString()}
                  </time>
                  {event.peerId ? `${shortId(event.peerId)} · ` : ""}
                  {event.event}
                </div>
              ))
            )}
          </div>
        </details>
        <p className="mt-4 text-center text-xs text-zinc-600">
          Signalling relays connection setup only. Chat and files travel peer to
          peer.
        </p>
      </div>
      {peerToVerify && identity && peerToVerify.fingerprint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="verify-title"
            className="w-full max-w-2xl rounded-2xl border border-zinc-700 bg-zinc-900 p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2
                  id="verify-title"
                  className="text-xl font-semibold text-zinc-100"
                >
                  Verify peer fingerprint
                </h2>
                <p className="mt-1 text-sm text-zinc-400">
                  Compare these fingerprints out of band before marking this
                  peer verified.
                </p>
              </div>
              <Button
                variant="outline"
                className="px-3 py-1.5 text-xs"
                onClick={() => setPeerToVerify(null)}
              >
                Close
              </Button>
            </div>
            <div className="mt-5 space-y-4">
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <p className="text-xs text-zinc-500">
                  My fingerprint · {identity.algorithm}
                </p>
                <p className="mt-2 break-all font-mono text-sm leading-7 tracking-wide text-zinc-100">
                  {groupedFingerprint(identity.fingerprint)}
                </p>
                <Button
                  variant="outline"
                  className="mt-3 px-3 py-1.5 text-xs"
                  onClick={() => void copyText(identity.fingerprint)}
                >
                  Copy my full fingerprint
                </Button>
              </div>
              <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <p className="text-xs text-zinc-500">
                  Peer {shortId(peerToVerify.peerId)} · {peerToVerify.algorithm}
                </p>
                <p className="mt-2 break-all font-mono text-sm leading-7 tracking-wide text-zinc-100">
                  {groupedFingerprint(peerToVerify.fingerprint)}
                </p>
                <Button
                  variant="outline"
                  className="mt-3 px-3 py-1.5 text-xs"
                  onClick={() => void copyText(peerToVerify.fingerprint!)}
                >
                  Copy peer full fingerprint
                </Button>
              </div>
            </div>
            <div className="mt-5 flex justify-end">
              <Button
                disabled={peerToVerify.verified}
                onClick={() => {
                  void verifyPeer(peerToVerify.peerId);
                  setPeerToVerify(null);
                }}
              >
                {peerToVerify.verified
                  ? "Already verified"
                  : "Mark as verified"}
              </Button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
