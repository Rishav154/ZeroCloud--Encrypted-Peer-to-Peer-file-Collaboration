"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  base64ToBytes,
  openInviteWorkspaceKey,
  openWorkspaceName,
} from "@zerocloud/shared";
import { Button } from "../../../components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "../../../components/ui/card";
import { useAuthStore } from "../../../lib/auth/session";
import { loadLocalIdentity, loginAccount } from "../../../lib/auth/api";
import { acceptInvite, fetchInvite } from "../../../lib/workspaces/api";

function InviteJoin() {
  const params = useParams<{ inviteId: string }>();
  const router = useRouter();
  const token = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);
  const authReady = useAuthStore((state) => state.ready);
  const hydrateAuth = useAuthStore((state) => state.hydrate);
  const setSession = useAuthStore((state) => state.setSession);
  const fragmentCaptured = useRef(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [invite, setInvite] = useState<Awaited<
    ReturnType<typeof fetchInvite>
  > | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authReady) hydrateAuth();
  }, [authReady, hydrateAuth]);

  useEffect(() => {
    if (fragmentCaptured.current) return;
    fragmentCaptured.current = true;
    const fragmentSecret = window.location.hash.slice(1);
    if (fragmentSecret) {
      setSecret(fragmentSecret);
      window.history.replaceState(null, "", window.location.pathname);
    } else {
      setError("Invite link is missing its secret.");
    }
  }, []);

  useEffect(() => {
    if (!token || !secret) return;
    void fetchInvite(token, params.inviteId)
      .then(async (record) => {
        setInvite(record);
        const normalized = secret.replace(/-/g, "+").replace(/_/g, "/");
        const secretBytes = base64ToBytes(
          normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
        );
        if (secretBytes.length !== 32)
          throw new Error("Invite link has an invalid secret.");
        const key = await openInviteWorkspaceKey(
          record.wrappedKey,
          secretBytes,
          record.workspaceId,
          record.inviteId,
          record.keyVersion,
        );
        if (record.nameSealed)
          setWorkspaceName(
            await openWorkspaceName(key, record.workspaceId, record.nameSealed, record.keyVersion),
          );
      })
      .catch((caught: unknown) =>
        setError(
          caught instanceof Error ? caught.message : "Could not load invite",
        ),
      );
  }, [params.inviteId, secret, token]);

  async function signIn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const identity = await loadLocalIdentity();
      const session = await loginAccount(
        {
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        },
        identity,
      );
      setSession(session);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Sign in failed");
    } finally {
      setBusy(false);
    }
  }

  async function join(): Promise<void> {
    if (!token || !user || !invite || !secret) return;
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(token, user, invite, secret);
      router.replace(`/w/${invite.workspaceId}`);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not accept invite",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen px-4 py-12">
      <Card className="mx-auto max-w-lg border-zinc-800 bg-zinc-950">
        <CardHeader>
          <CardTitle>Join workspace</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-zinc-400">
            {workspaceName
              ? `You were invited to ${workspaceName} as ${invite?.role}.`
              : "Validating invite…"}
          </p>
          {!authReady && (
            <p className="text-sm text-zinc-400">Restoring your sign-in…</p>
          )}
          {authReady && !token && (
            <form
              className="space-y-3"
              onSubmit={(event) => void signIn(event)}
            >
              <p className="text-sm text-zinc-400">
                Sign in to accept this invite. The invite secret stays in this
                tab while you sign in.
              </p>
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="Email"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
              />
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                required
                placeholder="Password"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
              />
              <Button type="submit" disabled={busy}>
                {busy ? "Signing in…" : "Sign in"}
              </Button>
              <p className="text-xs text-zinc-500">
                Need an account?{" "}
                <a
                  className="text-violet-300"
                  href="/register"
                  target="_blank"
                  rel="noreferrer"
                >
                  Register in another tab
                </a>
                , then sign in here.
              </p>
            </form>
          )}
          {error && (
            <p role="alert" className="text-sm text-rose-300">
              {error}
            </p>
          )}
          <Button
            onClick={() => void join()}
            disabled={busy || !invite || !secret}
          >
            {busy ? "Joining…" : "Accept invite"}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

export default function InviteJoinPage() {
  return <InviteJoin />;
}
