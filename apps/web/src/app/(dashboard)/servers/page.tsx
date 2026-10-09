"use client";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import {
  Plus,
  Server,
  RefreshCw,
  KeyRound,
  ShieldX,
  Terminal,
} from "lucide-react";
import { api, post } from "@/components/api";
import { Button, Card, Input, Pill, SectionHead } from "@/components/ui";
type ServerInfo = {
  id: string;
  name: string;
  ip: string | null;
  description: string | null;
  status: string;
  connected: boolean;
  agent_version: string | null;
  architecture: string | null;
  docker_available: boolean;
  caddy_available: boolean;
  terminal_available: boolean;
  metrics: {
    cpuPercent: number;
    memoryUsed: number;
    memoryTotal: number;
    diskUsed: number;
    diskTotal: number;
    containers?: {
      deploymentId: string;
      status: string;
      cpuPercent: number;
      memoryUsed: number;
      memoryLimit: number;
    }[];
  } | null;
  last_seen_at: string | null;
};
const size = (n: number) => (n ? `${(n / 1073741824).toFixed(1)} GB` : "—");
export default function ServersPage() {
  const origin = useSyncExternalStore(
    () => () => {},
    () => window.location.origin,
    () => "",
  );
  const [rootTerminal, setRootTerminal] = useState(true);
  const installCommand = `curl -fsSLo /tmp/deplo-install.sh ${origin}/agent/install.sh && sudo bash /tmp/deplo-install.sh ${origin}${rootTerminal ? "" : " --without-root-terminal"}`;
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [name, setName] = useState("");
  const [ip, setIp] = useState("");
  const [description, setDescription] = useState("");
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(
    () =>
      api<{ servers: ServerInfo[] }>("servers")
        .then((x) => setServers(x.servers))
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await post("servers", { name, ip, description });
      setName("");
      setIp("");
      setDescription("");
      await load();
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function pair(id: string) {
    try {
      const r = await post<{ token: string }>(`servers/${id}/pair`, {});
      setToken(r.token);
    } catch (x) {
      setError((x as Error).message);
    }
  }
  async function revoke(id: string) {
    if (
      !window.confirm(
        "Revoke this agent credential? The agent will stop receiving jobs.",
      )
    )
      return;
    try {
      await post(`servers/${id}/revoke`, {});
      await load();
    } catch (x) {
      setError((x as Error).message);
    }
  }
  return (
    <>
      <SectionHead
        eyebrow="Infrastructure"
        title="Servers"
        description="Your applications run here. Deplo only manages explicitly paired servers."
        action={
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw size={15} />
            Refresh
          </Button>
        }
      />
      {error && (
        <p
          role="alert"
          className="mb-5 rounded-lg border border-red-900/40 bg-red-950/30 p-3 text-sm text-red-300"
        >
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="mb-5 text-sm text-emerald-300">
          {message}
        </p>
      )}
      {token && (
        <Card className="mb-6 border-emerald-500/30 p-5">
          <div className="flex items-center gap-2 font-semibold text-emerald-300">
            <KeyRound size={16} />
            Pairing token
          </div>
          <p className="mt-2 text-sm text-slate-400">
            Shown once. Expires in 10 minutes. Paste it into the installer when
            prompted.
          </p>
          <code className="mt-4 block break-all rounded-lg bg-black/40 p-3 font-mono text-xs text-emerald-200">
            {token}
          </code>
          <button
            onClick={() => setToken("")}
            className="mt-3 text-xs text-slate-500 hover:text-white"
          >
            Dismiss
          </button>
        </Card>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_330px]">
        <div className="space-y-4">
          {servers.length > 0 && (
            <Card className="p-5">
              <h2 className="font-semibold">Connect a VPS</h2>
              <p className="mt-2 text-sm leading-6 text-slate-400">
                Run one command on an Ubuntu 24.04 or Linux Mint 22.2 Cinnamon
                server. It installs only the Deplo agent. Docker and Caddy can
                be installed later from the root terminal when you need them.
                When prompted, click <strong>Pair token</strong> below and paste
                the token into the server terminal.
              </p>
              <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  checked={rootTerminal}
                  onChange={(e) => setRootTerminal(e.target.checked)}
                  className="accent-emerald-400"
                />
                Enable root terminal for on-demand server setup
              </label>
              {rootTerminal && (
                <p className="mt-2 text-xs text-amber-200">
                  This grants full control of the server from your Deplo
                  account. Opening a session requires your password again and
                  expires after 10 minutes.
                </p>
              )}
              {origin.startsWith("https://") ? (
                <>
                  <pre className="mt-4 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-4 text-xs leading-5 text-emerald-200">
                    {installCommand}
                  </pre>
                  <Button
                    variant="secondary"
                    className="mt-3"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(installCommand);
                        setMessage("Install command copied");
                      } catch {
                        setError("Select and copy the command above");
                      }
                    }}
                  >
                    Copy command
                  </Button>
                </>
              ) : (
                <p className="mt-4 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs text-amber-200">
                  Publish this control plane at a trusted HTTPS URL to connect a
                  remote VPS.
                </p>
              )}
            </Card>
          )}
          {servers.length === 0 ? (
            <Card className="p-12 text-center">
              <Server className="mx-auto text-slate-600" />
              <h2 className="mt-4 font-semibold">No servers connected</h2>
              <p className="mt-2 text-sm text-slate-500">
                Register your first VPS to begin deploying.
              </p>
            </Card>
          ) : (
            servers.map((s) => (
              <Card key={s.id} className="p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-3">
                      <span className="rounded-lg border border-white/10 bg-white/[.04] p-2 text-slate-300">
                        <Server size={18} />
                      </span>
                      <div>
                        <h2 className="font-semibold">{s.name}</h2>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {s.ip || "IP not specified"} · Agent{" "}
                          {s.agent_version || "not paired"} ·{" "}
                          {s.architecture || "architecture unknown"}
                        </div>
                      </div>
                    </div>
                    {s.description && (
                      <p className="mt-3 text-sm text-slate-400">
                        {s.description}
                      </p>
                    )}
                  </div>
                  <Pill
                    tone={
                      s.connected
                        ? "good"
                        : s.status === "revoked"
                          ? "bad"
                          : "warn"
                    }
                  >
                    {s.connected
                      ? "Online"
                      : s.status === "revoked"
                        ? "Revoked"
                        : s.status === "unpaired"
                          ? "Unpaired"
                          : "Offline"}
                  </Pill>
                </div>
                {s.metrics && (
                  <div className="mt-5 grid gap-3 border-t border-white/[.07] pt-4 text-xs text-slate-400 sm:grid-cols-3">
                    <span>
                      CPU{" "}
                      <strong className="ml-1 text-slate-200">
                        {s.metrics.cpuPercent.toFixed(1)}%
                      </strong>
                    </span>
                    <span>
                      Memory{" "}
                      <strong className="ml-1 text-slate-200">
                        {size(s.metrics.memoryUsed)} /{" "}
                        {size(s.metrics.memoryTotal)}
                      </strong>
                    </span>
                    <span>
                      Disk{" "}
                      <strong className="ml-1 text-slate-200">
                        {size(s.metrics.diskUsed)} / {size(s.metrics.diskTotal)}
                      </strong>
                    </span>
                  </div>
                )}
                {s.metrics?.containers && s.metrics.containers.length > 0 && (
                  <div className="mt-4 border-t border-white/[.07] pt-4">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-slate-500">
                      Managed containers
                    </div>
                    {s.metrics.containers.map((c) => (
                      <div
                        key={c.deploymentId}
                        className="flex flex-wrap justify-between gap-2 py-1 text-xs text-slate-400"
                      >
                        <span className="font-mono">
                          {c.deploymentId.slice(0, 8)} · {c.status}
                        </span>
                        <span>
                          CPU {c.cpuPercent.toFixed(1)}% · RAM{" "}
                          {size(c.memoryUsed)} / {size(c.memoryLimit)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-white/[.07] pt-4 text-xs">
                  <span
                    className={
                      s.docker_available ? "text-emerald-300" : "text-slate-500"
                    }
                  >
                    Docker{" "}
                    {s.docker_available ? "available" : "optional · not ready"}
                  </span>
                  <span
                    className={
                      s.caddy_available ? "text-emerald-300" : "text-slate-500"
                    }
                  >
                    Caddy {s.caddy_available ? "ready" : "optional · not ready"}
                  </span>
                  <span className="flex-1" />
                  {s.connected && s.terminal_available && (
                    <a
                      href={`/servers/${s.id}/terminal`}
                      className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-slate-200 hover:bg-white/5"
                    >
                      <Terminal size={14} /> Root terminal
                    </a>
                  )}
                  <Button variant="secondary" onClick={() => void pair(s.id)}>
                    <KeyRound size={14} />
                    Pair token
                  </Button>
                  {s.status !== "revoked" && (
                    <Button variant="danger" onClick={() => void revoke(s.id)}>
                      <ShieldX size={14} />
                      Revoke
                    </Button>
                  )}
                </div>
              </Card>
            ))
          )}
        </div>
        <Card className="h-fit p-5">
          <h2 className="font-semibold">Add a server</h2>
          <p className="mt-1 text-xs leading-5 text-slate-500">
            No SSH password is needed. The agent connects outward over HTTPS.
          </p>
          <form onSubmit={add} className="mt-6 space-y-4">
            <label className="block text-xs text-slate-400">
              Display name
              <Input
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-2"
                placeholder="Production VPS"
              />
            </label>
            <label className="block text-xs text-slate-400">
              IP address <span className="text-slate-600">optional</span>
              <Input
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                className="mt-2"
                placeholder="203.0.113.10"
              />
            </label>
            <label className="block text-xs text-slate-400">
              Description <span className="text-slate-600">optional</span>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="mt-2"
                placeholder="Ubuntu 24.04"
              />
            </label>
            <Button type="submit" disabled={busy} className="w-full">
              <Plus size={16} />
              Register server
            </Button>
          </form>
          <p className="mt-4 text-xs text-slate-600">
            Next: run the setup command on the VPS. Generate a pairing token
            when the installer asks for it.
          </p>
        </Card>
      </div>
    </>
  );
}
