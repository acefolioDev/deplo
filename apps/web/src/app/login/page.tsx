"use client";
import { useState } from "react";
import { ArrowRight, Box } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { post } from "@/components/api";
import { useRouter } from "next/navigation";
export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [bootstrap, setBootstrap] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post(
        bootstrap ? "auth/bootstrap" : "auth/login",
        bootstrap
          ? { email, password, bootstrapToken: bootstrap }
          : { email, password },
      );
      if (bootstrap) await post("auth/login", { email, password });
      router.replace("/");
      router.refresh();
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-[radial-gradient(circle_at_50%_-10%,#15342b_0%,transparent_40%)] px-5">
      <div className="w-full max-w-sm">
        <div className="mb-10 flex items-center gap-3">
          <div className="rounded-xl bg-emerald-300 p-2 text-slate-950">
            <Box size={24} />
          </div>
          <div>
            <div className="text-2xl font-bold tracking-tight">
              deplo<span className="text-emerald-300">.</span>
            </div>
            <div className="text-xs text-slate-500">
              Deploy anywhere. Own everything.
            </div>
          </div>
        </div>
        <form
          onSubmit={submit}
          className="rounded-2xl border border-white/10 bg-[#11151a] p-7 shadow-2xl shadow-black/30"
        >
          <h1 className="text-xl font-semibold">Sign in to your workspace</h1>
          <p className="mt-1 text-sm text-slate-500">
            Manage your servers and deployments.
          </p>
          <label className="mt-7 block text-xs font-medium text-slate-300">
            Email
            <Input
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-2"
              placeholder="you@example.com"
            />
          </label>
          <label className="mt-4 block text-xs font-medium text-slate-300">
            Password
            <Input
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-2"
              placeholder="••••••••••••"
            />
          </label>
          <details className="mt-5 text-xs text-slate-500">
            <summary className="cursor-pointer hover:text-slate-300">
              First time setup
            </summary>
            <p className="mt-2 leading-relaxed">
              Enter the bootstrap token from your control plane environment.
              This creates the first owner account.
            </p>
            <Input
              type="password"
              value={bootstrap}
              onChange={(e) => setBootstrap(e.target.value)}
              className="mt-2"
              placeholder="Bootstrap token"
            />
          </details>
          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-red-900/40 bg-red-950/30 p-3 text-sm text-red-300"
            >
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="mt-6 w-full">
            {busy
              ? "Please wait…"
              : bootstrap
                ? "Create owner account"
                : "Sign in"}
            <ArrowRight size={16} />
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-slate-600">
          Your applications run on your own infrastructure.
        </p>
      </div>
    </main>
  );
}
