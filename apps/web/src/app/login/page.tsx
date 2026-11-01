"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  ApiError,
  loadLocalIdentity,
  type LocalIdentity,
  loginAccount,
} from "../../lib/auth/api";
import { useAuthStore } from "../../lib/auth/session";

function fullFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(" ") ?? fingerprint;
}

export default function LoginPage() {
  const router = useRouter();
  const setSession = useAuthStore((state) => state.setSession);
  const [identity, setIdentity] = useState<LocalIdentity | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadLocalIdentity()
      .then(setIdentity)
      .catch(() => setError("Could not load this browser's identity key"));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      if (!identity) throw new Error("Identity is not ready");
      const session = await loginAccount(
        {
          email: String(form.get("email") ?? ""),
          password: String(form.get("password") ?? ""),
        },
        identity,
      );
      setSession(session);
      router.replace("/workspaces");
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "IDENTITY_MISMATCH") {
        setError("This account is bound to a different device identity");
      } else {
        setError(caught instanceof Error ? caught.message : "Sign in failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen px-4 py-12">
      <Card className="mx-auto max-w-xl border-zinc-800 bg-zinc-950">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>
            Your account is bound to the browser identity shown below.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="mb-6 rounded-xl border border-zinc-800 bg-zinc-900/70 p-4 text-sm">
            <p className="text-zinc-400">This browser identity</p>
            {identity ? (
              <>
                <p className="mt-1 font-medium">{identity.algorithm}</p>
                <p className="mt-2 break-all font-mono text-xs text-violet-200">
                  {fullFingerprint(identity.fingerprint)}
                </p>
              </>
            ) : (
              <p className="mt-1 text-zinc-500">Loading identity…</p>
            )}
          </div>
          <p className="mb-5 text-sm text-amber-200">
            Clearing site data or resetting this identity permanently locks this
            account out of its workspaces. There is no recovery in this phase.
          </p>
          <form className="space-y-4" onSubmit={(event) => void submit(event)}>
            <label className="block text-sm text-zinc-300">
              Email
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
                name="email"
                type="email"
                autoComplete="email"
                required
                maxLength={320}
              />
            </label>
            <label className="block text-sm text-zinc-300">
              Password
              <input
                className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </label>
            {error && (
              <p role="alert" className="text-sm text-rose-300">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={!identity || busy}
              className="w-full"
            >
              {busy ? "Signing in…" : "Sign in"}
            </Button>
          </form>
          <p className="mt-5 text-sm text-zinc-400">
            Need an account?{" "}
            <Link
              className="text-violet-300 hover:text-violet-200"
              href="/register"
            >
              Register
            </Link>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
