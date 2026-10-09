"use client";
import { useEffect, useState } from "react";
import { api, post } from "@/components/api";
import { Card, Pill, SectionHead } from "@/components/ui";
type Deployment = {
  id: string;
  image_ref: string;
  image_digest: string | null;
  status: string;
  message: string | null;
  created_at: string;
  finished_at: string | null;
  project: string;
  environment: string;
};
export default function DeploymentsPage() {
  const [data, setData] = useState<Deployment[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = () =>
      api<{ deployments: Deployment[] }>("deployments")
        .then((r) => setData(r.deployments))
        .catch((e) => setError(e.message));
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <>
      <SectionHead
        eyebrow="Activity"
        title="Deployments"
        description="Every image rollout, with its actual agent reported status."
      />
      {error && (
        <p role="alert" className="text-red-300">
          {error}
        </p>
      )}
      <Card className="overflow-hidden">
        {data.length === 0 ? (
          <div className="p-12 text-center text-sm text-slate-500">
            No deployments yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-white/[.08] text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-5 py-4 font-medium">Project</th>
                  <th className="px-5 py-4 font-medium">Image</th>
                  <th className="px-5 py-4 font-medium">Status</th>
                  <th className="px-5 py-4 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) => (
                  <tr
                    key={d.id}
                    className="border-b border-white/[.05] last:border-0"
                  >
                    <td className="px-5 py-4 font-medium">
                      {d.project}
                      <div className="mt-1 text-xs text-slate-500">
                        {d.environment}
                      </div>
                    </td>
                    <td className="max-w-xs px-5 py-4">
                      <div className="truncate font-mono text-xs text-slate-300">
                        {d.image_digest || d.image_ref}
                      </div>
                      {d.message && (
                        <div className="mt-1 truncate text-xs text-slate-500">
                          {d.message}
                        </div>
                      )}
                    </td>
                    <td className="px-5 py-4">
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
                      {d.image_digest && (
                        <button
                          className="ml-3 text-xs text-emerald-300 hover:underline"
                          onClick={async () => {
                            try {
                              await post(`deployments/${d.id}/redeploy`, {});
                              window.location.reload();
                            } catch (e) {
                              setError((e as Error).message);
                            }
                          }}
                        >
                          Redeploy digest
                        </button>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-5 py-4 text-xs text-slate-500">
                      {new Date(d.created_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
