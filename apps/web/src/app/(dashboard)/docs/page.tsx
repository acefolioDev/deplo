import { Card, SectionHead } from "@/components/ui";
export default function DocsPage() {
  return (
    <>
      <SectionHead
        eyebrow="Guide"
        title="Get started"
        description="Connect a server first, then add only the software you need."
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
            "Pair the agent",
            "Run the setup command shown in Servers on Ubuntu 24.04 or Linux Mint 22.2. It installs the agent, enables the root terminal unless you opt out, verifies the binary, and asks for a one-time pairing token. Docker and Caddy are not installed.",
          ],
          [
            "03",
            "Install what you need",
            "Use the Deplo root terminal to add Docker when you want container deployments. Add Caddy only when you want public HTTPS domains. The server remains connected without either package.",
          ],
          [
            "04",
            "Deploy and inspect",
            "Create a project, deploy an OCI image, inspect status and logs, and optionally map a domain over HTTPS.",
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
        <h2 className="font-semibold">Optional software on your VPS</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          Run these commands in Deplo’s root terminal only when you need the
          feature. Docker runs container deployments:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-black/40 p-4 text-xs text-emerald-200">
          {
            "apt-get update && apt-get install -y docker.io && systemctl enable --now docker"
          }
        </pre>
        <p className="mt-4 text-sm leading-6 text-slate-400">
          For public HTTPS domains, install Caddy and let it load Deplo’s route
          files:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-black/40 p-4 text-xs leading-5 text-emerald-200">
          {
            "apt-get update && apt-get install -y caddy\ninstall -d -m 0755 /etc/caddy/deplo\ngrep -Fxq 'import /etc/caddy/deplo/*.caddy' /etc/caddy/Caddyfile || printf '\\nimport /etc/caddy/deplo/*.caddy\\n' >> /etc/caddy/Caddyfile\ncaddy validate --config /etc/caddy/Caddyfile --adapter caddyfile\nsystemctl enable --now caddy && systemctl reload caddy"
          }
        </pre>
      </Card>
      <Card className="mt-6 p-6">
        <h2 className="font-semibold">Guides</h2>
        <p className="mt-2 text-sm leading-6 text-slate-400">
          The repository has two guides: <code>docs/USER_GUIDE.md</code> for
          developers connecting servers and deploying applications, and{" "}
          <code>docs/PRODUCTION.md</code> for the Deplo host operator.
        </p>
      </Card>
    </>
  );
}
