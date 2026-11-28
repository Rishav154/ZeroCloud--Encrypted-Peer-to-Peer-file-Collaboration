"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { parseServerMessage, type NearbyControlPayload, type ServerSignalMessage } from "@zerocloud/shared";
import { useAnonymousNearbySocket } from "../../hooks/use-anonymous-nearby-socket";
import { useAuthStore } from "../../lib/auth/session";
import type { StoredIdentity } from "../../lib/identity/identityStore";
import { getAnonymousIdentity } from "../../lib/nearby/anonymousIdentityStore";
import { NearbyManager } from "../../lib/nearby/NearbyManager";
import { useNearbyStore } from "../../lib/nearby/nearby-store";
import { publicConfig } from "../../lib/config";
import { acceptInvite, createNearbyWorkspaceInvite, fetchInvite, revokeWorkspaceInvite, type WorkspaceView } from "../../lib/workspaces/api";
import { loadBlockedFingerprints, saveBlockedFingerprints } from "../../lib/nearby/blockList";

type NearbyContextValue = { identity: StoredIdentity | null; connect: (peerId: string) => void; enable: (alias: string) => boolean; disable: () => void; debugInject: (peerId: string, type: "sync" | "manifest") => void; sendFile: (peerId: string, file: File) => boolean; sendText: (peerId: string, text: string) => boolean; acceptOffer: (peerId: string, transferId: number) => void; declineOffer: (peerId: string, transferId: number, block?: boolean) => void; cancelFile: (peerId: string, transferId: number) => void; sendInvite: (peerId: string, workspace: WorkspaceView, role: "editor" | "viewer", expiresIn: "1h" | "24h") => Promise<void>; acceptInvite: (inviteId: string) => Promise<string | null>; declineInvite: (inviteId: string) => void; block: (fingerprint: string) => void; unblock: (fingerprint: string) => void };
const NearbyContext = createContext<NearbyContextValue | null>(null);

export function NearbyProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const { accessToken, user, hydrate } = useAuthStore();
  const nearbyEnabled = useNearbyStore((state) => state.enabled);
  const [identity, setIdentity] = useState<StoredIdentity | null>(null);
  const [pendingAlias, setPendingAlias] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const visibleAliasRef = useRef<string | null>(null);
  const managerRef = useRef<NearbyManager | null>(null);
  const sendRef = useRef<((message: unknown) => boolean) | null>(null);
  const pendingSecretsRef = useRef(new Map<string, Extract<NearbyControlPayload, { type: "workspace-invite" }>>());
  const pendingRedeemRef = useRef<string | null>(null);
  const previousTokenRef = useRef<string | null>(null);
  const expiryTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const verifiedRef = useRef<Set<string>>(new Set());
  const blockedRef = useRef<Set<string>>(new Set());
  const declineInviteRef = useRef<(inviteId: string) => void>(() => {});
  useEffect(() => { hydrate(); }, [hydrate]);
  useEffect(() => {
    if (previousTokenRef.current && !accessToken) {
      pendingRedeemRef.current = null; pendingSecretsRef.current.clear();
      for (const timer of expiryTimersRef.current.values()) clearTimeout(timer);
      expiryTimersRef.current.clear(); useNearbyStore.getState().reset();
    }
    previousTokenRef.current = accessToken;
  }, [accessToken]);
  useEffect(() => { void getAnonymousIdentity().then(setIdentity); }, []);
  useEffect(() => { blockedRef.current = loadBlockedFingerprints(); useNearbyStore.getState().setBlocked([...blockedRef.current]); }, []);

  const onMessage = useCallback((message: ServerSignalMessage) => {
    const manager = managerRef.current;
    const store = useNearbyStore.getState();
    if (message.type === "nearby-peers") { store.setPeers(message.peers); manager?.updateDirectory(message.peers); }
    else if (message.type === "nearby-peer-joined") { const peers = [...Object.values(useNearbyStore.getState().peers), message.peer]; store.setPeers(peers); manager?.updateDirectory(peers); }
    else if (message.type === "nearby-peer-left") { store.removePeer(message.peerId); manager?.remove(message.peerId); }
    else if (message.type === "nearby-signal") void manager?.handleSignal(message.from, message.data);
    else if (message.type === "nearby-group-info") store.setGroupId(message.groupId);
  }, []);
  const onOpen = useCallback(() => {
    const alias = pendingAlias ?? visibleAliasRef.current;
    if (!alias || !identity || !managerRef.current || !sendRef.current) return;
    const peerId = crypto.randomUUID(); managerRef.current.localPeerId = peerId;
    if (sendRef.current({ type: "nearby-enable", peerId, alias, publicKey: btoa(String.fromCharCode(...identity.publicKeyRaw)), keyAlg: identity.algorithm })) { managerRef.current.enable([]); useNearbyStore.getState().setEnabled(true); }
    setPendingAlias(null);
  }, [pendingAlias, identity]);
  const onDisconnect = useCallback(() => { managerRef.current?.disable(); useNearbyStore.getState().reset(true); }, []);
  const { send } = useAnonymousNearbySocket((value) => {
    const parsed = parseServerMessage(JSON.stringify(value));
    if (parsed.success) onMessage(parsed.data);
  }, onOpen, visible || pendingAlias !== null || nearbyEnabled, onDisconnect);
  sendRef.current = send;

  useEffect(() => {
    if (!identity) return;
    const iceServers: RTCIceServer[] = publicConfig.NEXT_PUBLIC_STUN_URLS.split(",").map((value) => value.trim()).filter(Boolean).map((urls) => ({ urls }));
    const turnUrls = publicConfig.NEXT_PUBLIC_TURN_URL.split(",").map((value) => value.trim()).filter(Boolean);
    if (turnUrls.length) iceServers.push({ urls: turnUrls, ...(publicConfig.NEXT_PUBLIC_TURN_USERNAME ? { username: publicConfig.NEXT_PUBLIC_TURN_USERNAME } : {}), ...(publicConfig.NEXT_PUBLIC_TURN_CREDENTIAL ? { credential: publicConfig.NEXT_PUBLIC_TURN_CREDENTIAL } : {}) });
    const manager = new NearbyManager(identity, (message) => send(message), iceServers);
    manager.events.on("peer", useNearbyStore.getState().setPeer);
    manager.events.on("unreachable", ({ peerId }) => useNearbyStore.getState().removePeer(peerId));
    manager.events.on("dropped", ({ count }) => { for (let i = 0; i < count; i += 1) useNearbyStore.getState().countDrop(); });
    manager.setBlockedFingerprints(blockedRef.current);
    manager.events.on("offer", (offer) => useNearbyStore.getState().setOffer({ ...offer, state: "pending" }));
    manager.events.on("transfer", (transfer) => useNearbyStore.getState().setTransfer(transfer));
    manager.events.on("text", (message) => useNearbyStore.getState().addText({ id: message.payload.id, peerId: message.peerId, alias: message.alias, fingerprint: message.fingerprint, text: message.payload.text }));
    manager.events.on("invite", ({ peerId, payload }) => {
      manager.takeInvite(payload.inviteId);
      const peer = useNearbyStore.getState().peers[peerId];
      if (!peer || Date.parse(payload.expiresAt) <= Date.now()) { manager.sendControl(peerId, { type: "invite-ack", inviteId: payload.inviteId, declined: true }); return; }
      pendingSecretsRef.current.set(payload.inviteId, payload);
      useNearbyStore.getState().setInviteCard({ type: payload.type, inviteId: payload.inviteId, workspaceName: payload.workspaceName, role: payload.role, expiresAt: payload.expiresAt, peerId, alias: peer.alias, fingerprint: peer.fingerprint, verified: verifiedRef.current.has(peer.fingerprint) });
      const timer = setTimeout(() => declineInviteRef.current(payload.inviteId), Math.min(15 * 60_000, Math.max(0, Date.parse(payload.expiresAt) - Date.now())));
      expiryTimersRef.current.set(payload.inviteId, timer);
    });
    manager.events.on("inviteAck", ({ payload }) => {
      const status = useNearbyStore.getState().inviteStatuses.find((item) => item.inviteId === payload.inviteId);
      if (!status || status.status !== "sent") return;
      const timer = expiryTimersRef.current.get(payload.inviteId); if (timer) clearTimeout(timer);
      expiryTimersRef.current.delete(payload.inviteId);
      const nextStatus = payload.declined ? "declined" : "accepted";
      useNearbyStore.getState().setInviteStatus({ ...status, status: nextStatus });
      if (payload.declined && accessToken) void revokeWorkspaceInvite(accessToken, status.workspaceId, status.inviteId).catch(() => undefined);
    });
    managerRef.current = manager;
    return () => { manager.disable(); if (managerRef.current === manager) managerRef.current = null; useNearbyStore.getState().reset(true); };
  }, [identity, send, accessToken]);

  const enable = useCallback((alias: string): boolean => {
    if (!identity) return false;
    visibleAliasRef.current = alias;
    setVisible(true);
    setPendingAlias(alias);
    return true;
  }, [identity]);
  const disable = useCallback((): void => { visibleAliasRef.current = null; setVisible(false); sendRef.current?.({ type: "nearby-disable" }); managerRef.current?.disable(); useNearbyStore.getState().reset(true); setPendingAlias(null); }, []);
  const connect = useCallback((peerId: string): void => managerRef.current?.connect(peerId), []);
  const debugInject = useCallback((peerId: string, type: "sync" | "manifest"): void => managerRef.current?.debugInject(peerId, type), []);
  const sendFile = useCallback((peerId: string, file: File): boolean => managerRef.current?.sendFile(peerId, file) ?? false, []);
  const sendText = useCallback((peerId: string, text: string): boolean => managerRef.current?.sendText(peerId, text) ?? false, []);
  const acceptOffer = useCallback((peerId: string, transferId: number): void => managerRef.current?.acceptOffer(peerId, transferId), []);
  const declineOffer = useCallback((peerId: string, transferId: number): void => managerRef.current?.declineOffer(peerId, transferId), []);
  const cancelFile = useCallback((peerId: string, transferId: number): void => managerRef.current?.cancelFile(peerId, transferId), []);
  const declineInvite = useCallback((inviteId: string): void => {
    if (pendingRedeemRef.current === inviteId) pendingRedeemRef.current = null;
    const payload = pendingSecretsRef.current.get(inviteId);
    const card = useNearbyStore.getState().inviteCards.find((item) => item.inviteId === inviteId);
    if (payload && card) managerRef.current?.sendControl(card.peerId, { type: "invite-ack", inviteId, declined: true });
    pendingSecretsRef.current.delete(inviteId);
    const timer = expiryTimersRef.current.get(inviteId); if (timer) clearTimeout(timer);
    expiryTimersRef.current.delete(inviteId); useNearbyStore.getState().removeInviteCard(inviteId);
  }, []);
  declineInviteRef.current = declineInvite;
  const acceptNearbyInvite = useCallback(async (inviteId: string): Promise<string | null> => {
    const payload = pendingSecretsRef.current.get(inviteId);
    const card = useNearbyStore.getState().inviteCards.find((item) => item.inviteId === inviteId);
    if (!payload || !card) return null;
    if (!accessToken || !user) { pendingRedeemRef.current = inviteId; return null; }
    const timer = expiryTimersRef.current.get(inviteId); if (timer) clearTimeout(timer);
    const invite = await fetchInvite(accessToken, inviteId);
    await acceptInvite(accessToken, user, invite, payload.secret);
    managerRef.current?.sendControl(card.peerId, { type: "invite-ack", inviteId, declined: false });
    pendingSecretsRef.current.delete(inviteId); expiryTimersRef.current.delete(inviteId); useNearbyStore.getState().removeInviteCard(inviteId);
    return invite.workspaceId;
  }, [accessToken, user]);
  useEffect(() => {
    const inviteId = pendingRedeemRef.current;
    if (!inviteId || !accessToken || !user) return;
    pendingRedeemRef.current = null;
    void acceptNearbyInvite(inviteId).catch(() => { pendingRedeemRef.current = inviteId; });
  }, [accessToken, user, acceptNearbyInvite]);
  const sendInvite = useCallback(async (peerId: string, workspace: WorkspaceView, role: "editor" | "viewer", expiresIn: "1h" | "24h"): Promise<void> => {
    if (!accessToken) throw new Error("Sign in before inviting a nearby peer");
    const result = await createNearbyWorkspaceInvite(accessToken, workspace, role, expiresIn);
    const payload = { type: "workspace-invite" as const, inviteId: result.invite.inviteId, secret: result.secret, workspaceName: workspace.name, role, expiresAt: result.invite.expiresAt };
    if (!managerRef.current?.sendControl(peerId, payload)) {
      await revokeWorkspaceInvite(accessToken, workspace.id, result.invite.inviteId);
      throw new Error("Nearby connection closed before the invite could be sent");
    }
    const peer = useNearbyStore.getState().peers[peerId];
    const status = { inviteId: result.invite.inviteId, workspaceId: workspace.id, peerId, alias: peer?.alias ?? "Nearby peer", workspaceName: workspace.name, role, expiresAt: result.invite.expiresAt, status: "sent" as const };
    useNearbyStore.getState().setInviteStatus(status);
    const timer = setTimeout(() => {
      expiryTimersRef.current.delete(status.inviteId);
      const current = useNearbyStore.getState().inviteStatuses.find((item) => item.inviteId === status.inviteId);
      if (!current || current.status !== "sent") return;
      useNearbyStore.getState().setInviteStatus({ ...current, status: "expired" });
      void revokeWorkspaceInvite(accessToken, workspace.id, result.invite.inviteId).catch(() => undefined);
    }, Math.max(0, Date.parse(result.invite.expiresAt) - Date.now()));
    expiryTimersRef.current.set(result.invite.inviteId, timer);
  }, [accessToken]);
  const block = useCallback((fingerprint: string): void => { blockedRef.current.add(fingerprint); managerRef.current?.block(fingerprint); saveBlockedFingerprints(blockedRef.current); useNearbyStore.getState().setBlocked([...blockedRef.current]); }, []);
  const unblock = useCallback((fingerprint: string): void => { blockedRef.current.delete(fingerprint); managerRef.current?.unblock(fingerprint); saveBlockedFingerprints(blockedRef.current); useNearbyStore.getState().setBlocked([...blockedRef.current]); }, []);
  return <NearbyContext.Provider value={{ identity, connect, enable, disable, debugInject, sendFile, sendText, acceptOffer, declineOffer, cancelFile, sendInvite, acceptInvite: acceptNearbyInvite, declineInvite, block, unblock }}>{children}<NearbyTextInbox /></NearbyContext.Provider>;
}

function NearbyTextInbox() {
  const texts = useNearbyStore((state) => state.texts);
  if (!texts.length) return null;
  return <aside aria-label="Nearby messages" className="fixed bottom-4 right-4 z-50 max-h-[70vh] w-[min(24rem,calc(100vw-2rem))] space-y-3 overflow-auto">{texts.map((item) => { const url = safeHttpUrl(item.text); return <article key={item.id} className="rounded-xl border border-zinc-700 bg-zinc-950 p-4 text-zinc-100 shadow-xl"><p className="text-xs text-zinc-400">{item.alias} · {item.fingerprint.slice(0, 12)}</p><pre className="my-3 whitespace-pre-wrap break-words font-sans text-sm">{item.text}</pre>{url && <p className="mb-3 text-xs text-zinc-300">Link host: <strong>{url.hostname}</strong></p>}<div className="flex gap-2"><button className="rounded border border-zinc-700 px-3 py-1 text-sm" onClick={() => void navigator.clipboard.writeText(item.text)}>Copy</button>{url && <button className="rounded border border-zinc-700 px-3 py-1 text-sm" onClick={() => window.open(url.href, "_blank", "noopener,noreferrer")}>Open link</button>}<button className="rounded border border-zinc-700 px-3 py-1 text-sm" onClick={() => useNearbyStore.getState().removeText(item.id)}>Dismiss</button></div></article>; })}</aside>;
}

function safeHttpUrl(text: string): URL | null {
  const value = text.trim(); if (!value || value.length > 2048) return null;
  try { const url = new URL(value); return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url : null; } catch { return null; }
}

export function useNearby(): NearbyContextValue {
  const value = useContext(NearbyContext);
  if (!value) throw new Error("useNearby must be used within NearbyProvider");
  return value;
}
