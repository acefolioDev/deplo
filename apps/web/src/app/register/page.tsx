"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Box } from "lucide-react";
import { Button, Input } from "@/components/ui";
import { post } from "@/components/api";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== confirmation) {
      setError("Passwords do not match");
      return;
    }
    setBusy(true);
    try {
      await post("auth/register", { email, password, registrationCode });
      router.replace("/");
      router.refresh();
    } catch (cause) {
      setError((cause as Error).message);
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
          <h1 className="text-xl font-semibold">Create your Deplo account</h1>
          <p className="mt-1 text-sm text-slate-500">
            Your servers and projects belong to your account.
          </p>
          <label className="mt-7 block text-xs font-medium text-slate-300">
            Email
            <Input
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="mt-2"
              placeholder="you@example.com"
            />
          </label>
          <label className="mt-4 block text-xs font-medium text-slate-300">
            Password
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="mt-2"
              placeholder="At least 12 characters"
            />
          </label>
          <label className="mt-4 block text-xs font-medium text-slate-300">
            Confirm password
            <Input
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className="mt-2"
              placeholder="Repeat password"
            />
          </label>
          <label className="mt-4 block text-xs font-medium text-slate-300">
            Registration code{" "}
            <span className="text-slate-500">(if your host provided one)</span>
            <Input
              type="password"
              autoComplete="off"
              value={registrationCode}
              onChange={(event) => setRegistrationCode(event.target.value)}
              className="mt-2"
              placeholder="Code from your Deplo host"
            />
          </label>
          {error && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-red-900/40 bg-red-950/30 p-3 text-sm text-red-300"
            >
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy} className="mt-6 w-full">
            {busy ? "Creating account…" : "Create account"}
            <ArrowRight size={16} />
          </Button>
        </form>
        <p className="mt-5 text-center text-sm text-slate-400">
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-medium text-emerald-300 hover:text-emerald-200"
          >
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
