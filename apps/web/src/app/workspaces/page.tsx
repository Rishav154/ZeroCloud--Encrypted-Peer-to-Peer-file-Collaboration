"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import { AuthGate } from "../../components/auth/AuthGate";
import { useAuthStore } from "../../lib/auth/session";
import {
  createWorkspace,
  listWorkspaces,
  type WorkspaceView,
} from "../../lib/workspaces/api";

function WorkspaceList() {
  const router = useRouter();
  const accessToken = useAuthStore((state) => state.accessToken);
  const user = useAuthStore((state) => state.user);
  const clearSession = useAuthStore((state) => state.clearSession);
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    if (!accessToken || !user) return;
    try {
      setWorkspaces(await listWorkspaces(accessToken, user));
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not load workspaces",
      );
    }
  }, [accessToken, user]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!accessToken || !user || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const id = await createWorkspace(accessToken, user, name.trim());
      router.push(`/w/${id}`);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not create workspace",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen px-4 py-10">
      <div className="mx-auto max-w-4xl">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-violet-300">
              ZeroCloud · Workspaces
            </p>
            <h1 className="mt-2 text-3xl font-semibold">Your workspaces</h1>
            <p className="mt-2 text-sm text-zinc-400">
              Signed in as {user?.displayName} · {user?.email}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link href="/" className="text-sm text-zinc-400 hover:text-white">
              My workspaces
            </Link>
            <Button variant="outline" onClick={clearSession}>
              Sign out
            </Button>
          </div>
        </header>
        <Card className="mb-6 border-zinc-800 bg-zinc-950">
          <CardHeader>
            <CardTitle>Create workspace</CardTitle>
            <CardDescription>
              The name and workspace key are encrypted in your browser before
              the server receives them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="flex flex-col gap-3 sm:flex-row"
              onSubmit={(event) => void submit(event)}
            >
              <input
                className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
                aria-label="Workspace name"
                placeholder="Workspace name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                required
              />
              <Button type="submit" disabled={busy || !name.trim()}>
                {busy ? "Creating…" : "Create workspace"}
              </Button>
            </form>
            {error && (
              <p role="alert" className="mt-3 text-sm text-rose-300">
                {error}
              </p>
            )}
          </CardContent>
        </Card>
        <section className="space-y-3" aria-label="Workspace list">
          {workspaces.length === 0 && !error && (
            <p className="rounded-xl border border-dashed border-zinc-800 p-8 text-center text-sm text-zinc-500">
              No workspaces yet. Create one above.
            </p>
          )}
          {workspaces.map((workspace) => (
            <Link
              key={workspace.id}
              href={`/w/${workspace.id}`}
              className="block rounded-xl border border-zinc-800 bg-zinc-950 px-5 py-4 transition hover:border-violet-700"
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-medium">{workspace.name}</h2>
                  <p className="mt-1 text-xs text-zinc-500">
                    {workspace.members.length} member
                    {workspace.members.length === 1 ? "" : "s"}
                  </p>
                </div>
                <span className="rounded-full border border-zinc-700 px-3 py-1 text-xs capitalize text-zinc-300">
                  {workspace.role}
                </span>
              </div>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}

export default function WorkspacesPage() {
  return (
    <AuthGate>
      <WorkspaceList />
    </AuthGate>
  );
}
