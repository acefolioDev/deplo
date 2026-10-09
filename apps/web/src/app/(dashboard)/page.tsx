"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight, Box, Server, Activity, Clock3, Plus } from "lucide-react";
import { api } from "@/components/api";
import { Card, Pill, SectionHead } from "@/components/ui";
type Overview = {
  servers: number;
  applications: number;
  recentDeployments: {
    id: string;
    status: string;
    image_ref: string;
    project: string;
    environment: string;
    created_at: string;
  }[];
};
export default function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Overview>("overview")
      .then(setData)
      .catch((e) => setError(e.message));
  }, []);
  return (
    <>
      <SectionHead
        eyebrow="Workspace overview"
        title="Your infrastructure, at a glance"
        description="Deploy and manage applications on servers you own."
        action={
          <Link
            href="/projects"
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-300 px-3.5 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-200"
          >
            <Plus size={16} />
            New project
          </Link>
        }
      />
      {error && (
        <p role="alert" className="mb-5 text-red-300">
          {error}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          {
            label: "Connected servers",
            value: data?.servers,
            icon: Server,
            href: "/servers",
          },
          {
            label: "Active applications",
            value: data?.applications,
            icon: Box,
            href: "/projects",
          },
          {
            label: "Recent deployments",
            value: data?.recentDeployments.length,
            icon: Activity,
            href: "/deployments",
          },
        ].map((x) => (
          <Link key={x.label} href={x.href}>
            <Card className="p-5 transition-colors hover:border-white/20">
              <div className="flex items-center justify-between text-slate-500">
                <span className="text-sm">{x.label}</span>
                <x.icon size={18} />
              </div>
              <div className="mt-6 text-3xl font-semibold tracking-tight">
                {x.value ?? "—"}
              </div>
              <div className="mt-3 flex items-center gap-1 text-xs text-emerald-300">
                View details <ArrowRight size={12} />
              </div>
            </Card>
          </Link>
        ))}
      </div>
      <div className="mt-8 grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <div className="flex items-center justify-between border-b border-white/[.07] px-5 py-4">
            <h2 className="font-semibold">Recent deployments</h2>
            <Link
              href="/deployments"
              className="text-xs text-slate-400 hover:text-white"
            >
              View all →
            </Link>
          </div>
          {!data ? (
            <div className="p-8 text-sm text-slate-500">
              Loading deployments…
            </div>
          ) : data.recentDeployments.length === 0 ? (
            <div className="p-10 text-center">
              <Clock3 className="mx-auto mb-3 text-slate-600" />
              <p className="text-sm text-slate-400">No deployments yet</p>
              <Link
                href="/projects"
                className="mt-3 inline-block text-sm text-emerald-300"
              >
                Create a project →
              </Link>
            </div>
          ) : (
            <div>
              {data.recentDeployments.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-4 border-b border-white/[.05] px-5 py-4 last:border-0"
                >
                  <div>
                    <div className="text-sm font-medium">
                      {d.project} <span className="text-slate-600">/</span>{" "}
                      {d.environment}
                    </div>
                    <div className="mt-1 max-w-[300px] truncate font-mono text-xs text-slate-500">
                      {d.image_ref}
                    </div>
                  </div>
                  <Pill
                    tone={
                      d.status === "healthy"
                        ? "good"
                        : d.status === "failed"
                          ? "bad"
                          : "warn"
                    }
                  >
                    {d.status}
                  </Pill>
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card className="p-5">
          <div className="text-xs font-semibold uppercase tracking-[.15em] text-emerald-300">
            Getting started
          </div>
          <h2 className="mt-3 text-lg font-semibold">Bring your own server</h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            Register a Linux VPS, pair the lightweight agent, then deploy a
            prebuilt container image.
          </p>
          <Link
            href="/servers"
            className="mt-5 inline-flex items-center gap-2 text-sm font-medium text-emerald-300"
          >
            Add a server <ArrowRight size={15} />
          </Link>
          <div className="mt-7 border-t border-white/[.07] pt-5 text-xs leading-5 text-slate-500">
            The control plane sends jobs. Your application containers stay on
            your VPS, even when this dashboard is offline.
          </div>
        </Card>
      </div>
    </>
  );
}
