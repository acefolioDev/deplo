import { Card, SectionHead } from "@/components/ui";
export default function DocsPage() {
  return (
    <>
      <SectionHead
        eyebrow="Guide"
        title="Get started"
        description="A short path from a fresh server to your first deployment."
      />
      <div className="grid gap-4 md:grid-cols-2">
        {[
          [
            "01",
            "Register a server",
            "Add your VPS in the Servers page. Deplo does not need an SSH password.",
          ],
          [
            "02",
            "Install and pair the agent",
            "Run the setup command shown in Servers on Ubuntu 24.04 or compatible Linux Mint. It installs missing Docker and Caddy packages, verifies the agent binary, and prompts for a one-time pairing token.",
          ],
          [
            "03",
            "Create a project",
            "Choose the server, then configure production and staging image references, ports, and health paths.",
          ],
          [
            "04",
            "Deploy and inspect",
            "Save settings, deploy an OCI image, inspect status and recent logs, and map a domain to reach it over HTTPS.",
          ],
        ].map(([number, title, body]) => (
          <Card key={number} className="p-6">
            <div className="text-sm font-semibold text-emerald-300">
              {number}
            </div>
            <h2 className="mt-3 font-semibold">{title}</h2>
            <p className="mt-2 text-sm leading-6 text-slate-400">{body}</p>
          </Card>
        ))}
      </div>
      <Card className="mt-6 p-6">
        <h2 className="font-semibold">Detailed operator guides</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          The repository includes <code>docs/agent-installation.md</code>,{" "}
          <code>docs/local-development.md</code>,{" "}
          <code>docs/deployment.md</code>, <code>docs/security.md</code>, and{" "}
          <code>docs/troubleshooting.md</code>. Review those files before using
          a public VPS.
        </p>
      </Card>
    </>
  );
}
