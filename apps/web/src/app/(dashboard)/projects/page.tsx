"use client";
import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Plus,
  Play,
  RotateCw,
  Square,
  ScrollText,
  Globe,
  KeyRound,
} from "lucide-react";
import { api, patch, post } from "@/components/api";
import { Button, Card, Input, Pill, SectionHead } from "@/components/ui";
import { RuntimeOptions } from "@/components/runtime-options";
type Env = {
  id: string;
  name: string;
  imageRef: string | null;
  port: number;
  healthPath: string;
  activeDeploymentId: string | null;
  runtimeStatus?: string;
  volumePath?: string | null;
  registryUsername?: string | null;
  hasRegistryToken?: boolean;
};
type Project = {
  id: string;
  name: string;
  server_id: string;
  server_name: string;
  environments: Env[];
};
type Server = { id: string; name: string };
type Job = {
  id: string;
  kind: string;
  status: string;
  result?: { lines?: string[] };
  error?: string;
};
export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [servers, setServers] = useState<Server[]>([]);
  const [name, setName] = useState("");
  const [serverId, setServerId] = useState("");
  const [selected, setSelected] = useState("");
  const [image, setImage] = useState<Record<string, string>>({});
  const [port, setPort] = useState<Record<string, string>>({});
  const [health, setHealth] = useState<Record<string, string>>({});
  const [varName, setVarName] = useState("");
  const [varValue, setVarValue] = useState("");
  const [domain, setDomain] = useState("");
  const [variables, setVariables] = useState<{ name: string }[]>([]);
  const [domains, setDomains] = useState<
    { id: string; hostname: string; status: string }[]
  >([]);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try {
      const [p, s] = await Promise.all([
        api<{ projects: Project[] }>("projects"),
        api<{ servers: Server[] }>("servers"),
      ]);
      setProjects(p.projects);
      setServers(s.servers);
      if (!serverId && s.servers[0]) setServerId(s.servers[0].id);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [serverId]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const env = projects
    .flatMap((p) => p.environments)
    .find((e) => e.id === selected);
  const project = projects.find((p) =>
    p.environments.some((e) => e.id === selected),
  );
  useEffect(() => {
    if (!selected) return;
    api<{ variables: { name: string }[] }>(`environments/${selected}/variables`)
      .then((r) => setVariables(r.variables))
      .catch(() => {});
    api<{ domains: { id: string; hostname: string; status: string }[] }>(
      `environments/${selected}/domains`,
    )
      .then((r) => setDomains(r.domains))
      .catch(() => {});
  }, [selected]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function create(e: React.FormEvent) {
    e.preventDefault();
    await act(async () => {
      await post("projects", { name, serverId });
      setName("");
      setMessage("Project created with production and staging environments.");
    });
  }
  async function save() {
    if (!env) return;
    await act(async () => {
      await patch(`environments/${env.id}`, {
        imageRef: image[env.id] ?? env.imageRef,
        port: Number(port[env.id] ?? env.port),
        healthPath: health[env.id] ?? env.healthPath,
      });
      setMessage("Deployment settings saved.");
    });
  }
  async function queue(kind: "deploy" | "stop" | "restart" | "logs") {
    if (!env) return;
    await act(async () => {
      const r = await post<{ job?: Job; deployment?: { id: string } }>(
        `environments/${env.id}/${kind}`,
        {},
      );
      setMessage(
        kind === "deploy"
          ? `Deployment ${r.deployment?.id} queued.`
          : `${kind} job queued.`,
      );
      if (kind === "logs" && r.job) void waitJob(r.job.id);
    });
  }
  async function waitJob(id: string) {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const { job } = await api<{ job: Job }>(`jobs/${id}`);
      if (job.status === "done") {
        setLogs(job.result?.lines ?? []);
        return;
      }
      if (job.status === "failed") {
        setError(job.error ?? "Log retrieval failed");
        return;
      }
    }
    setMessage("Log job is still pending; refresh later.");
  }
  async function addVariable(e: React.FormEvent) {
    e.preventDefault();
    if (!env) return;
    await act(async () => {
      await post(`environments/${env.id}/variables`, {
        name: varName,
        value: varValue,
      });
      setVarName("");
      setVarValue("");
      const r = await api<{ variables: { name: string }[] }>(
        `environments/${env.id}/variables`,
      );
      setVariables(r.variables);
    });
  }
  async function addDomain(e: React.FormEvent) {
    e.preventDefault();
    if (!env) return;
    await act(async () => {
      await post(`environments/${env.id}/domains`, { hostname: domain });
      setDomain("");
      const r = await api<{
        domains: { id: string; hostname: string; status: string }[];
      }>(`environments/${env.id}/domains`);
      setDomains(r.domains);
      setMessage("Domain saved. Redeploy to activate its Caddy route.");
    });
  }
  return (
    <>
      <SectionHead
        eyebrow="Applications"
        title="Projects"
        description="Deploy prebuilt OCI images to production or staging."
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
        <p
          role="status"
          className="mb-5 rounded-lg border border-emerald-900/40 bg-emerald-950/30 p-3 text-sm text-emerald-300"
        >
          {message}
        </p>
      )}
      <div className="grid gap-6 xl:grid-cols-[280px_1fr]">
        <div className="space-y-5">
          <Card className="p-4">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-widest text-slate-500">
              Your projects
            </h2>
            {projects.length === 0 ? (
              <p className="py-4 text-sm text-slate-500">No projects yet.</p>
            ) : (
              projects.map((p) => (
                <div key={p.id} className="mb-3">
                  <div className="flex items-center gap-2 px-2 py-2 text-sm font-medium">
                    <Box size={15} className="text-emerald-300" />
                    {p.name}
                  </div>
                  {p.environments.map((e) => (
                    <button
                      key={e.id}
                      onClick={() => setSelected(e.id)}
                      className={`flex w-full items-center justify-between rounded-lg px-4 py-2 text-left text-sm ${selected === e.id ? "bg-emerald-300/10 text-emerald-200" : "text-slate-500 hover:bg-white/[.04] hover:text-white"}`}
                    >
                      <span>{e.name}</span>
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${e.activeDeploymentId ? "bg-emerald-300" : "bg-slate-700"}`}
                      />
                    </button>
                  ))}
                </div>
              ))
            )}
          </Card>
          <Card className="p-5">
            <h2 className="text-sm font-semibold">Create project</h2>
            <form onSubmit={create} className="mt-4 space-y-3">
              <Input
                required
                placeholder="Project name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <select
                required
                value={serverId}
                onChange={(e) => setServerId(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-[#11151a] px-3 py-2.5 text-sm"
              >
                <option value="">Select server</option>
                {servers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <Button
                disabled={busy || !serverId}
                type="submit"
                className="w-full"
              >
                <Plus size={15} />
                Create
              </Button>
            </form>
          </Card>
        </div>
        {!env ? (
          <Card className="flex min-h-[400px] flex-col items-center justify-center p-10 text-center">
            <Box className="text-slate-600" size={32} />
            <h2 className="mt-4 font-semibold">Select an environment</h2>
            <p className="mt-2 max-w-sm text-sm text-slate-500">
              Choose a project environment to configure its image, variables,
              domain, and deployments.
            </p>
          </Card>
        ) : (
          <div className="space-y-6">
            <Card className="p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="text-xs uppercase tracking-widest text-emerald-300">
                    {project?.name} / {env.name}
                  </div>
                  <h2 className="mt-2 text-xl font-semibold">
                    Deployment settings
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Running on {project?.server_name}
                  </p>
                </div>
                <Pill tone={env.activeDeploymentId ? "good" : "neutral"}>
                  {env.runtimeStatus === "running"
                    ? "Running"
                    : env.activeDeploymentId
                      ? "Stopped"
                      : "Not deployed"}
                </Pill>
              </div>
              <div className="mt-6 grid gap-4 md:grid-cols-[2fr_1fr_1fr]">
                <label className="text-xs text-slate-400">
                  Container image
                  <Input
                    className="mt-2"
                    placeholder="ghcr.io/owner/app:v1"
                    value={image[env.id] ?? env.imageRef ?? ""}
                    onChange={(e) =>
                      setImage({ ...image, [env.id]: e.target.value })
                    }
                  />
                </label>
                <label className="text-xs text-slate-400">
                  Internal port
                  <Input
                    className="mt-2"
                    type="number"
                    value={port[env.id] ?? env.port}
                    onChange={(e) =>
                      setPort({ ...port, [env.id]: e.target.value })
                    }
                  />
                </label>
                <label className="text-xs text-slate-400">
                  Health path
                  <Input
                    className="mt-2"
                    value={health[env.id] ?? env.healthPath}
                    onChange={(e) =>
                      setHealth({ ...health, [env.id]: e.target.value })
                    }
                  />
                </label>
              </div>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button
                  onClick={() => void save()}
                  disabled={busy}
                  variant="secondary"
                >
                  Save settings
                </Button>
                <Button onClick={() => void queue("deploy")} disabled={busy}>
                  <Play size={14} />
                  Deploy
                </Button>
                <Button
                  onClick={() => void queue("restart")}
                  disabled={busy || !env.activeDeploymentId}
                  variant="secondary"
                >
                  <RotateCw size={14} />
                  Restart
                </Button>
                <Button
                  onClick={() => void queue("stop")}
                  disabled={busy || !env.activeDeploymentId}
                  variant="secondary"
                >
                  <Square size={14} />
                  Stop
                </Button>
                <Button
                  onClick={() => void queue("logs")}
                  disabled={busy || !env.activeDeploymentId}
                  variant="secondary"
                >
                  <ScrollText size={14} />
                  Recent logs
                </Button>
              </div>
              <p className="mt-4 text-xs text-slate-600">
                Save settings before deploying. The agent only replaces the old
                container after the new one passes its health check.
              </p>
            </Card>
            <RuntimeOptions key={env.id} environment={env} onSaved={load} />
            <div className="grid gap-6 lg:grid-cols-2">
              <Card className="p-6">
                <h3 className="flex items-center gap-2 font-semibold">
                  <KeyRound size={16} className="text-emerald-300" />
                  Variables
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  Values are encrypted and never shown again after saving.
                </p>
                <div className="mt-4 space-y-2">
                  {variables.map((v) => (
                    <div
                      key={v.name}
                      className="flex justify-between rounded-lg border border-white/[.06] bg-white/[.025] px-3 py-2 text-sm"
                    >
                      <code>{v.name}</code>
                      <div className="flex items-center gap-3">
                        <span className="text-slate-600">••••••••</span>
                        <button
                          className="text-xs text-red-300 hover:underline"
                          onClick={async () => {
                            try {
                              await api(
                                `environments/${env.id}/variables/${encodeURIComponent(v.name)}`,
                                { method: "DELETE" },
                              );
                              setVariables(
                                variables.filter((x) => x.name !== v.name),
                              );
                            } catch (e) {
                              setError((e as Error).message);
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <form
                  onSubmit={addVariable}
                  className="mt-4 flex flex-col gap-2 sm:flex-row"
                >
                  <Input
                    required
                    placeholder="NAME"
                    value={varName}
                    onChange={(e) => setVarName(e.target.value)}
                  />
                  <Input
                    type="password"
                    placeholder="Value"
                    value={varValue}
                    onChange={(e) => setVarValue(e.target.value)}
                  />
                  <Button type="submit" disabled={busy}>
                    Save
                  </Button>
                </form>
              </Card>
              <Card className="p-6">
                <h3 className="flex items-center gap-2 font-semibold">
                  <Globe size={16} className="text-emerald-300" />
                  Domains
                </h3>
                <p className="mt-1 text-xs text-slate-500">
                  Point an A record at your server IP. Caddy requests HTTPS
                  certificates.
                </p>
                <div className="mt-4 space-y-2">
                  {domains.map((d) => (
                    <div
                      key={d.id}
                      className="flex items-center justify-between rounded-lg border border-white/[.06] bg-white/[.025] px-3 py-2 text-sm"
                    >
                      <span>{d.hostname}</span>
                      <div className="flex items-center gap-3">
                        <Pill
                          tone={d.status === "configured" ? "good" : "warn"}
                        >
                          {d.status}
                        </Pill>
                        <button
                          className="text-xs text-red-300 hover:underline"
                          onClick={async () => {
                            try {
                              await api(
                                `environments/${env.id}/domains/${d.id}`,
                                { method: "DELETE" },
                              );
                              setDomains(domains.filter((x) => x.id !== d.id));
                              setMessage(
                                "Domain removed. Redeploy to update the Caddy route.",
                              );
                            } catch (e) {
                              setError((e as Error).message);
                            }
                          }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <form onSubmit={addDomain} className="mt-4 flex gap-2">
                  <Input
                    required
                    placeholder="app.example.com"
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                  />
                  <Button type="submit" disabled={busy}>
                    Add
                  </Button>
                </form>
              </Card>
            </div>
            {logs.length > 0 && (
              <Card className="p-5">
                <h3 className="font-semibold">Recent logs</h3>
                <pre className="mt-4 max-h-80 overflow-auto rounded-lg bg-black/50 p-4 text-xs leading-5 text-slate-300">
                  {logs.join("\n")}
                </pre>
              </Card>
            )}
          </div>
        )}
      </div>
    </>
  );
}
