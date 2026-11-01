"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatFingerprint } from "@zerocloud/shared";
import { AuthGate } from "../../../components/auth/AuthGate";
import WorkspacePeerPanel from "../../../components/workspaces/WorkspacePeerPanel";
import FilesTab from "../../../components/workspaces/FilesTab";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { useAuthStore } from "../../../lib/auth/session";
import { usePeerStore } from "../../../lib/peer-store";
import {
  changeWorkspaceMemberRole,
  createWorkspaceInvite,
  listWorkspaceInvites,
  loadWorkspace,
  removeWorkspaceMember,
  rotateWorkspaceKey,
  leaveWorkspace,
  revokeWorkspaceInvite,
  type InviteRecord,
  type WorkspaceView,
} from "../../../lib/workspaces/api";
import { workspaceKeyring } from "../../../lib/workspaces/keyring";
import { confirmWorkspaceMemberKeyPinUpdate, saveVerifiedFingerprint } from "../../../lib/identity/identityStore";

function WorkspaceDetail() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const token = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);
  const [workspace, setWorkspace] = useState<WorkspaceView | null>(null);
  const [invites, setInvites] = useState<InviteRecord[]>([]);
  const [inviteRole, setInviteRole] = useState<"editor" | "viewer">("editor");
  const [expiry, setExpiry] = useState<"1h" | "24h" | "7d">("24h");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [qrData, setQrData] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<"members" | "peers" | "files">(
    "members",
  );
  const peers = usePeerStore((state) => state.peers);
  const liveMembers = usePeerStore((state) => state.members);
  const removedMemberIds = usePeerStore((state) => state.removedMemberIds);
  const setMembers = usePeerStore((state) => state.setMembers);
  const initializedMembersFor = useRef<string | null>(null);

  useEffect(() => {
    if (!workspace || initializedMembersFor.current === workspace.id) return;
    initializedMembersFor.current = workspace.id;
    setMembers(workspace.members);
  }, [setMembers, workspace]);

  useEffect(() => {
    if (!workspace || initializedMembersFor.current !== workspace.id) return;
    const role = user?.id ? liveMembers[user.id]?.role : undefined;
    if (role && role !== workspace.role) {
      setWorkspace((current) => (current ? { ...current, role } : current));
    }
  }, [liveMembers, user?.id, workspace]);

  const visibleMembers = workspace
    ? [
        ...workspace.members
          .filter((member) => !removedMemberIds[member.userId])
          .map((member) => liveMembers[member.userId] ?? member),
        ...Object.values(liveMembers).filter(
          (member) =>
            !workspace.members.some(
              (entry) => entry.userId === member.userId,
            ) && !removedMemberIds[member.userId],
        ),
      ]
    : [];

  const load = useCallback(async (): Promise<void> => {
    if (!token || !user || !params.id) return;
    try {
      const loaded = await loadWorkspace(token, user, params.id);
      setWorkspace(loaded);
      setError(null);
      if (loaded.role === "owner")
        setInvites(await listWorkspaceInvites(token, loaded.id));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not load workspace",
      );
    }
  }, [params.id, token, user]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onUpdated = (event: Event): void => {
      const updated = (event as CustomEvent<WorkspaceView>).detail;
      if (updated?.id === params.id) setWorkspace(updated);
    };
    const onRotationNeeded = (event: Event): void => {
      const eventWorkspaceId = (event as CustomEvent<string>).detail;
      if (eventWorkspaceId === params.id) setWorkspace((current) => current ? { ...current, needsRotation: true } : current);
    };
    const onKicked = (event: Event): void => {
      const eventWorkspaceId = (event as CustomEvent<string>).detail;
      if (eventWorkspaceId === params.id) router.push("/workspaces");
    };
    window.addEventListener("zerocloud:workspace-updated", onUpdated);
    window.addEventListener("zerocloud:rotation-needed", onRotationNeeded);
    window.addEventListener("zerocloud:workspace-kicked", onKicked);
    return () => {
      window.removeEventListener("zerocloud:workspace-updated", onUpdated);
      window.removeEventListener("zerocloud:rotation-needed", onRotationNeeded);
      window.removeEventListener("zerocloud:workspace-kicked", onKicked);
    };
  }, [params.id, router]);

  async function makeInvite(): Promise<void> {
    if (!token || !workspace || !user) return;
    setBusy(true);
    try {
      const result = await createWorkspaceInvite(
        token,
        workspace,
        inviteRole,
        expiry,
      );
      setInviteLink(result.link);
      setQrData(
        await QRCode.toDataURL(result.link, {
          margin: 1,
          width: 180,
          color: { dark: "#f4f4f5", light: "#09090b" },
        }),
      );
      setInvites((current) => [result.invite, ...current]);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create invite",
      );
    } finally {
      setBusy(false);
    }
  }

  async function revoke(inviteId: string): Promise<void> {
    if (!token || !workspace || !user) return;
    try {
      await revokeWorkspaceInvite(token, workspace.id, inviteId);
      setInvites((current) =>
        current.filter((item) => item.inviteId !== inviteId),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not revoke invite",
      );
    }
  }

  async function copyInviteLink(): Promise<void> {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setError(null);
    } catch {
      setError("Could not copy invite link");
    }
  }

  async function changeRole(
    userId: string,
    role: "editor" | "viewer",
  ): Promise<void> {
    if (!token || !workspace) return;
    try {
      await changeWorkspaceMemberRole(token, workspace.id, userId, role);
      setWorkspace((current) =>
        current
          ? {
              ...current,
              members: current.members.map((member) =>
                member.userId === userId ? { ...member, role } : member,
              ),
            }
          : current,
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not change member role",
      );
    }
  }

  async function removeMember(userId: string): Promise<void> {
    if (!token || !workspace || !user) return;
    try {
      await removeWorkspaceMember(token, user, workspace, userId, async (latest) => {
        const target = latest.members.find((member) => member.userId === userId);
        const recipients = latest.members.filter((member) => member.userId !== userId);
        const summary = recipients.map((member) => `${member.displayName}: ${member.verified ? "Verified" : "Unverified"} · ${formatFingerprint(member.fingerprint)}`).join("\n");
        if (!window.confirm(`Remove ${target?.displayName ?? "this member"} and rotate the key for these recipients?\n${summary}`)) return false;
        return !recipients.some((member) => !member.verified) || window.confirm("One or more recipients are unverified. Compare each listed fingerprint through a trusted channel before proceeding.");
      });
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not remove member",
      );
    }
  }

  async function rotateKey(): Promise<void> {
    if (!token || !workspace || !user) return;
    if (workspace.members.some((member) => member.pinStatus === "mismatch" || member.pinStatus === "invalid")) {
      setError("A member key changed: possible server tampering. Rotation is blocked.");
      return;
    }
    setBusy(true);
    try {
      await rotateWorkspaceKey(token, user, workspace, async (latest) => {
        const latestSummary = latest.members.map((member) => `${member.displayName}: ${member.verified ? "Verified" : "Unverified"} · ${formatFingerprint(member.fingerprint)}`).join("\n");
        if (!window.confirm(`Rotate the workspace key for these members?\n${latestSummary}`)) return false;
        return !latest.members.some((member) => !member.verified) || window.confirm("One or more members are unverified. Compare each listed fingerprint through a trusted channel before proceeding.");
      });
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not rotate workspace key");
    } finally {
      setBusy(false);
    }
  }

  async function leave(): Promise<void> {
    if (!token || !workspace || !window.confirm("Leave this workspace? The owner will need to rotate its key.")) return;
    try {
      await leaveWorkspace(token, workspace.id);
      workspaceKeyring.clearWorkspace(workspace.id);
      router.push("/workspaces");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not leave workspace");
    }
  }

  async function updateMemberPin(userId: string): Promise<void> {
    if (!workspace) return;
    const member = workspace.members.find((entry) => entry.userId === userId);
    if (!member || !window.confirm(`The key for ${member.displayName} changed. Verify this fingerprint out of band before replacing the saved pin:\n${formatFingerprint(member.fingerprint)}\n\nProceed with the pin update?`)) return;
    try {
      await confirmWorkspaceMemberKeyPinUpdate({ workspaceId: workspace.id, userId, fingerprint: member.fingerprint, publicKey: member.publicKey });
      await saveVerifiedFingerprint(member.fingerprint);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not update the member key pin");
    }
  }

  return (
    <main className="min-h-screen px-4 py-10">
      <div className="mx-auto max-w-5xl">
        <Link
          className="text-sm text-violet-300 hover:text-violet-200"
          href="/workspaces"
        >
          ← All workspaces
        </Link>
        {error && (
          <p
            role="alert"
            className="mt-6 rounded-lg border border-rose-900 bg-rose-950/50 p-4 text-sm text-rose-200"
          >
            {error}
          </p>
        )}
        {!workspace && !error && (
          <p className="mt-6 text-sm text-zinc-400">Decrypting workspace…</p>
        )}
        {workspace && user && (
          <>
            <header className="my-7">
              <p className="text-xs font-semibold uppercase tracking-[0.25em] text-violet-300">
                Workspace · {workspace.role}
              </p>
              <h1 className="mt-2 text-3xl font-semibold">{workspace.name}</h1>
              <p className="mt-2 text-sm text-zinc-500">
                Key version {workspace.currentKeyVersion}
              </p>
              {workspace.needsRotation && (
                <p role="status" className="mt-3 rounded-lg border border-amber-800 bg-amber-950/40 p-3 text-sm text-amber-200">
                  A member left. Rotate the workspace key to protect new content from their old key.
                </p>
              )}
              <div className="mt-4 flex gap-2">
                {workspace.role === "owner" && <Button disabled={busy} onClick={() => void rotateKey()}>Rotate workspace key</Button>}
                {workspace.role !== "owner" && <Button variant="outline" onClick={() => void leave()}>Leave workspace</Button>}
              </div>
            </header>
            <nav
              aria-label="Workspace sections"
              className="mb-5 flex gap-2 border-b border-zinc-800"
            >
              {(
                [
                  ["members", "Members"],
                  ["peers", "Peers & chat"],
                  ["files", "Files"],
                ] as const
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  type="button"
                  aria-current={activeTab === tab ? "page" : undefined}
                  onClick={() => setActiveTab(tab)}
                  className={`border-b-2 px-3 py-3 text-sm ${activeTab === tab ? "border-violet-400 text-violet-200" : "border-transparent text-zinc-400 hover:text-zinc-200"}`}
                >
                  {label}
                </button>
              ))}
            </nav>
            {activeTab === "members" && (
              <>
                <Card className="border-zinc-800 bg-zinc-950">
                  <CardHeader>
                    <CardTitle>Members</CardTitle>
                    <CardDescription>
                      Workspace identities and live peer presence.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    {visibleMembers.map((member) => {
                      const pinStatus = workspace?.members.find((entry) => entry.userId === member.userId)?.pinStatus ?? "pinned";
                      const online = Object.values(peers).filter(
                        (peer) => peer.userId === member.userId,
                      );
                      const verified = online.some(
                        (peer) =>
                          peer.handshakeState === "secure" && peer.verified,
                      );
                      return (
                        <div
                          key={member.userId}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3"
                        >
                          <div className="min-w-0">
                            <p className="font-medium">
                              <span
                                className={`mr-2 inline-block h-2 w-2 rounded-full ${online.length ? "bg-emerald-400" : "bg-zinc-600"}`}
                              />
                              {member.displayName}
                              {member.userId === user?.id ? " (you)" : ""}
                              {verified && (
                                <span className="ml-2 rounded-full bg-emerald-950 px-2 py-0.5 text-[10px] text-emerald-200">
                                  Verified
                                </span>
                              )}
                              <span className={`ml-2 rounded-full px-2 py-0.5 text-[10px] ${pinStatus === "match" ? "bg-emerald-950 text-emerald-200" : pinStatus === "mismatch" || pinStatus === "invalid" ? "bg-rose-950 text-rose-200" : "bg-amber-950 text-amber-200"}`}>
                                {pinStatus === "match" ? "Pinned" : pinStatus === "mismatch" || pinStatus === "invalid" ? "Key changed" : "Unverified"}
                              </span>
                            </p>
                            <p className="mt-1 break-all font-mono text-xs text-zinc-500">
                              {formatFingerprint(member.fingerprint)}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-zinc-500">
                              {online.length
                                ? `${online.length} online`
                                : "offline"}
                            </span>
                            {workspace.role === "owner" &&
                            member.role !== "owner" ? (
                              <>
                                {pinStatus === "mismatch" && <Button variant="outline" className="px-2 py-1 text-xs" onClick={() => void updateMemberPin(member.userId)}>Review changed key</Button>}
                                <select
                                  aria-label={`Role for ${member.displayName}`}
                                  value={member.role}
                                  onChange={(event) =>
                                    void changeRole(
                                      member.userId,
                                      event.target.value as "editor" | "viewer",
                                    )
                                  }
                                  className="rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs"
                                >
                                  <option value="editor">Editor</option>
                                  <option value="viewer">Viewer</option>
                                </select>
                                <Button
                                  variant="outline"
                                  className="px-2 py-1 text-xs"
                                  onClick={() =>
                                    void removeMember(member.userId)
                                  }
                                >
                                  Remove and rotate key
                                </Button>
                              </>
                            ) : (
                              <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs capitalize text-zinc-300">
                                {member.role}
                              </span>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
                {workspace.role === "owner" && (
                  <Card className="mt-5 border-zinc-800 bg-zinc-950">
                    <CardHeader>
                      <CardTitle>Invites</CardTitle>
                      <CardDescription>
                        The secret is held in the link fragment and is never
                        sent to the server.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="flex flex-wrap gap-2">
                        <select
                          aria-label="Invite role"
                          value={inviteRole}
                          onChange={(event) =>
                            setInviteRole(
                              event.target.value as "editor" | "viewer",
                            )
                          }
                          className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
                        >
                          <option value="editor">Editor</option>
                          <option value="viewer">Viewer</option>
                        </select>
                        <select
                          aria-label="Invite expiry"
                          value={expiry}
                          onChange={(event) =>
                            setExpiry(event.target.value as "1h" | "24h" | "7d")
                          }
                          className="rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
                        >
                          <option value="1h">1 hour</option>
                          <option value="24h">24 hours</option>
                          <option value="7d">7 days</option>
                        </select>
                        <Button
                          disabled={busy}
                          onClick={() => void makeInvite()}
                        >
                          {busy ? "Creating…" : "Create invite"}
                        </Button>
                      </div>
                      {inviteLink && (
                        <div className="flex flex-wrap items-center gap-4 rounded-lg border border-zinc-800 p-3">
                          <div className="min-w-0 flex-1">
                            <p className="break-all font-mono text-xs text-zinc-300">
                              {inviteLink}
                            </p>
                            <Button
                              variant="outline"
                              className="mt-2 px-3 py-1 text-xs"
                              onClick={() => void copyInviteLink()}
                            >
                              Copy invite link
                            </Button>
                          </div>
                          {qrData && (
                            <img
                              alt="Invite QR code"
                              src={qrData}
                              width={180}
                              height={180}
                            />
                          )}
                        </div>
                      )}
                      {invites.map((invite) => (
                        <div
                          key={invite.inviteId}
                          className="flex items-center justify-between rounded border border-zinc-800 px-3 py-2 text-xs"
                        >
                          <span className="font-mono">
                            {invite.inviteId.slice(0, 8)} · {invite.role} ·
                            expires{" "}
                            {new Date(invite.expiresAt).toLocaleString()}
                          </span>
                          <Button
                            variant="outline"
                            className="px-2 py-1"
                            onClick={() => void revoke(invite.inviteId)}
                          >
                            Revoke
                          </Button>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </>
            )}
            <div className={`mt-5 ${activeTab === "peers" ? "" : "hidden"}`}>
              <WorkspacePeerPanel
                workspaceId={workspace.id}
                role={workspace.role}
              />
            </div>
            {activeTab === "files" && (
              <FilesTab
                workspaceId={workspace.id}
                role={workspace.role}
                fingerprint={user.fingerprint}
                displayName={user.displayName}
              />
            )}
            <p className="mt-5 rounded-lg border border-amber-900/70 bg-amber-950/30 p-4 text-sm text-amber-200">
              Removed members keep files they already received but cannot decrypt anything new.
            </p>
            <div className="mt-5">
              <Button variant="outline" onClick={() => void load()}>
                Reload workspace
              </Button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

export default function WorkspacePage() {
  return (
    <AuthGate>
      <WorkspaceDetail />
    </AuthGate>
  );
}
