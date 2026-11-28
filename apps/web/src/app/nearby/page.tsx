"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../../components/ui/button";
import { useAuthStore } from "../../lib/auth/session";
import { loadVerifiedFingerprints, saveVerifiedFingerprint } from "../../lib/identity/identityStore";
import { useNearbyStore } from "../../lib/nearby/nearby-store";
import { useNearby } from "../../components/nearby/NearbyProvider";
import { listWorkspaces, type WorkspaceView } from "../../lib/workspaces/api";
import { requiresUnverifiedInviteConfirmation } from "../../lib/nearby/policy";

const adjectives = ["Bronze", "Quiet", "Silver", "Misty", "Amber", "Cobalt"];
const nouns = ["Locust", "Heron", "Comet", "Badger", "Otter", "Maple"];
function randomAlias(): string { return `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`; }

export default function NearbyPage() {
  const router = useRouter();
  const { accessToken, ready, hydrate } = useAuthStore();
  const user = useAuthStore((state) => state.user);
  const nearby = useNearby();
  const enabled = useNearbyStore((state) => state.enabled);
  const groupId = useNearbyStore((state) => state.groupId);
  const peersById = useNearbyStore((state) => state.peers);
  const peers = useMemo(() => Object.values(peersById), [peersById]);
  const dropped = useNearbyStore((state) => state.dropped);
  const offers = useNearbyStore((state) => state.offers);
  const transfers = useNearbyStore((state) => state.transfers);
  const inviteCards = useNearbyStore((state) => state.inviteCards);
  const inviteStatuses = useNearbyStore((state) => state.inviteStatuses);
  const blocked = useNearbyStore((state) => state.blocked);
  const identity = nearby.identity;
  const [verified, setVerified] = useState<Set<string>>(new Set());
  const debugNearby = process.env.NEXT_PUBLIC_DEBUG_NEARBY === "true";
  const [alias, setAlias] = useState(randomAlias());
  const [aliasEdited, setAliasEdited] = useState(false);
  const [ownedWorkspaces, setOwnedWorkspaces] = useState<WorkspaceView[]>([]);
  const [workspaceId, setWorkspaceId] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [inviteExpiry, setInviteExpiry] = useState<"1h" | "24h">("1h");
  useEffect(() => { hydrate(); }, [hydrate]);
  useEffect(() => { if (ready && !accessToken) router.replace("/login"); }, [ready, accessToken, router]);
  useEffect(() => { void loadVerifiedFingerprints().then(setVerified); }, []);
  useEffect(() => {
    if (!accessToken || !user) { setOwnedWorkspaces([]); return; }
    void listWorkspaces(accessToken, user).then((workspaces) => setOwnedWorkspaces(workspaces.filter((workspace) => workspace.role === "owner"))).catch(() => setOwnedWorkspaces([]));
  }, [accessToken, user]);
  const shortFingerprint = useMemo(() => identity?.fingerprint.slice(0, 12) ?? "loading", [identity]);
  function toggleNearby(): void {
    if (enabled) { nearby.disable(); return; }
    if (!identity) return;
    const nextAlias = aliasEdited ? alias : randomAlias();
    if (!aliasEdited) setAlias(nextAlias);
    nearby.enable(nextAlias);
  }
  function downloadOffer(blob: Blob, name: string): void {
    const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function invitePeer(peerId: string, fingerprint: string): Promise<void> {
    const workspace = ownedWorkspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    if (requiresUnverifiedInviteConfirmation(verified.has(fingerprint)) && !window.confirm("This peer is unverified. Continue only if you trust the fingerprint shown on this device.")) return;
    if (!window.confirm(`The workspace name “${workspace.name}” will be revealed to this peer. Send the invite?`)) return;
    await nearby.sendInvite(peerId, workspace, inviteRole, inviteExpiry);
  }
  async function acceptNearbyInvite(inviteId: string): Promise<void> {
    try {
      const destination = await nearby.acceptInvite(inviteId);
      if (destination) router.replace(`/w/${destination}`);
      else router.push("/login");
    } catch (error) { window.alert(error instanceof Error ? error.message : "Could not accept nearby invite"); }
  }

  return <main className="min-h-screen bg-zinc-950 px-4 py-10 text-zinc-100"><div className="mx-auto max-w-5xl space-y-6">
    <header className="flex items-end justify-between"><div><a href="/workspaces" className="text-sm text-violet-300">← Workspaces</a><h1 className="mt-2 text-3xl font-semibold">Nearby</h1><p className="mt-2 max-w-2xl text-sm text-zinc-400">Anyone on this network who has ZeroCloud open and Nearby on can see your alias and key fingerprint.</p></div><Button onClick={toggleNearby}>{enabled ? "Turn Nearby off" : "Turn Nearby on"}</Button></header>
    <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-5"><div className="flex flex-wrap items-center gap-4"><label className="text-sm">Your alias <input className="ml-2 rounded bg-zinc-800 px-3 py-2" value={alias} maxLength={24} onChange={(event) => { setAlias(event.target.value); setAliasEdited(true); }} /></label><span className="text-sm text-zinc-400">Fingerprint {shortFingerprint}</span><span className="text-sm text-zinc-400">Group {enabled ? groupId ?? "connecting…" : "off"}</span></div></section>
    <section><h2 className="mb-3 text-lg font-medium">Devices on this network</h2>{peers.length ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{peers.map((peer) => {
      const isVerified = verified.has(peer.fingerprint);
      const canAct = enabled && peer.state === "secure";
      return <article key={peer.peerId} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"><div className="flex justify-between"><strong>{peer.alias}</strong><span className="rounded-full bg-zinc-800 px-2 py-1 text-xs">{peer.state}</span></div><p className="mt-2 text-xs text-zinc-400">{peer.fingerprint.slice(0, 12)} · {identity?.fingerprint === peer.fingerprint ? "Same identity" : isVerified ? "Verified" : "Unverified"}</p>{peer.error && <p className="mt-2 text-xs text-rose-300">{peer.error}</p>}<div className="mt-3 flex flex-wrap gap-2"><Button variant="outline" disabled={isVerified} onClick={() => { if (window.confirm(`Compare this fingerprint with ${peer.alias} through a trusted channel before verifying:\n\n${peer.fingerprint}`)) void saveVerifiedFingerprint(peer.fingerprint).then(() => setVerified((previous) => new Set(previous).add(peer.fingerprint))); }}>Verify</Button><Button disabled={!enabled || peer.state === "connecting" || peer.state === "handshaking" || peer.state === "secure"} onClick={() => nearby.connect(peer.peerId)}>{peer.state === "failed" ? "Retry" : "Connect"}</Button>{canAct && <label className="cursor-pointer rounded-md border border-zinc-700 px-3 py-2 text-sm hover:bg-zinc-800">Send file<input type="file" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) nearby.sendFile(peer.peerId, file); event.currentTarget.value = ""; }} /></label>}</div>
        {canAct && <div className="mt-4 space-y-2 border-t border-zinc-800 pt-3"><p className="text-xs font-medium text-zinc-300">Invite to workspace</p><select className="w-full rounded bg-zinc-800 p-2 text-sm" value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}><option value="">Choose an owned workspace</option>{ownedWorkspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select><div className="flex gap-2"><select className="rounded bg-zinc-800 p-2 text-sm" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as "editor" | "viewer")}><option value="editor">Editor</option><option value="viewer">Viewer</option></select><select className="rounded bg-zinc-800 p-2 text-sm" value={inviteExpiry} onChange={(event) => setInviteExpiry(event.target.value as "1h" | "24h")}><option value="1h">Expires in 1 hour</option><option value="24h">Expires in 24 hours</option></select><Button variant="outline" disabled={!workspaceId || !ownedWorkspaces.length} onClick={() => void invitePeer(peer.peerId, peer.fingerprint)}>Invite</Button></div></div>}
      </article>;
    })}</div> : <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-zinc-400">{enabled ? "Waiting for nearby devices…" : "Nearby is off"}</p>}</section>

    {offers.length > 0 && <section><h2 className="mb-3 text-lg font-medium">Nearby file offers</h2><div className="space-y-3">{offers.map((offer) => { const isVerified = verified.has(offer.fingerprint); return <article key={`${offer.peerId}:${offer.transferId}`} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium">{offer.alias} · {offer.fingerprint.slice(0, 12)} · {isVerified ? "Verified" : "Unverified"}</h3>{!isVerified && <p className="mt-1 text-sm text-amber-300">Unverified nearby peer. Check the fingerprint before accepting.</p>}<p className="mt-2 text-sm">{offer.metadata.name} · {formatFileSize(offer.metadata.size)}</p><p className="text-xs text-zinc-500">{offer.state}{offer.error ? ` · ${offer.error}` : ""}</p></div>{offer.state === "pending" && <div className="flex gap-2"><Button onClick={() => nearby.acceptOffer(offer.peerId, offer.transferId)}>Accept</Button><Button variant="outline" onClick={() => nearby.declineOffer(offer.peerId, offer.transferId)}>Decline</Button><Button variant="outline" onClick={() => { nearby.declineOffer(offer.peerId, offer.transferId); nearby.block(offer.fingerprint); }}>Block</Button></div>}{offer.state === "receiving" && <Button variant="outline" onClick={() => nearby.cancelFile(offer.peerId, offer.transferId)}>Cancel</Button>}{offer.state === "done" && offer.blob && <Button onClick={() => downloadOffer(offer.blob!, offer.metadata.name)}>Download</Button>}</div></article>; })}</div></section>}
    {transfers.length > 0 && <section><h2 className="mb-3 text-lg font-medium">Transfers</h2><div className="space-y-2">{transfers.map((transfer) => <div key={transfer.key} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm">{transfer.name} · {transfer.state} · {Math.round(transfer.progress * 100)}%{transfer.error ? ` · ${transfer.error}` : ""}</div>)}</div></section>}

    {inviteCards.length > 0 && <section><h2 className="mb-3 text-lg font-medium">Workspace invitations</h2><div className="space-y-3">{inviteCards.map((invite) => <article key={invite.inviteId} className="rounded-xl border border-zinc-800 bg-zinc-900 p-4"><h3 className="font-medium">{invite.alias} · {invite.fingerprint.slice(0, 12)} · {invite.verified ? "Verified" : "Unverified"}</h3><p className="mt-2">Workspace name stated by sender: <strong>{invite.workspaceName}</strong> <span className="text-amber-300">(unverified)</span></p><p className="text-sm text-zinc-400">Role: {invite.role} · Expires {new Date(invite.expiresAt).toLocaleString()}</p><div className="mt-3 flex gap-2"><Button onClick={() => void acceptNearbyInvite(invite.inviteId)}>Accept</Button><Button variant="outline" onClick={() => nearby.declineInvite(invite.inviteId)}>Decline</Button></div></article>)}</div></section>}
    {inviteStatuses.length > 0 && <section><h2 className="mb-3 text-lg font-medium">Sent nearby invites</h2><div className="space-y-2">{inviteStatuses.map((status) => <div key={status.inviteId} className="rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm">{status.workspaceName} → {status.alias} · {status.role} · {status.status}</div>)}</div></section>}
    {blocked.length > 0 && <section><h2 className="mb-3 text-lg font-medium">Blocked fingerprints</h2><div className="space-y-2">{blocked.map((fingerprint) => <div key={fingerprint} className="flex items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 p-3 text-sm"><span>{fingerprint}</span><Button variant="outline" onClick={() => nearby.unblock(fingerprint)}>Unblock</Button></div>)}</div></section>}
    <p className="text-xs text-zinc-500">Dropped nearby messages and limited offers: {dropped}</p>
    {debugNearby && peers[0] && <div className="flex gap-2"><Button variant="outline" onClick={() => nearby.debugInject(peers[0]!.peerId, "sync")}>Debug: send sync</Button><Button variant="outline" onClick={() => nearby.debugInject(peers[0]!.peerId, "manifest")}>Debug: send manifest</Button></div>}
  </div></main>;
}

function formatFileSize(bytes: number): string { if (!bytes) return "0 B"; const units = ["B", "KB", "MB", "GB", "TB"]; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); return `${(bytes / 1024 ** index).toFixed(1)} ${units[index]}`; }
