# Local Mac and Linux Mint setup

The Mac runs Next.js and PostgreSQL. Linux Mint runs Docker Engine, Caddy, and the agent. Both machines must be on a trusted LAN with a reachable Mac address. The control plane must be exposed to the agent over TLS with a certificate trusted by Linux Mint; the agent refuses non-loopback HTTP and never disables TLS verification.

1. On the Mac, create a local development PostgreSQL database and set `DATABASE_URL`, `BOOTSTRAP_TOKEN`, and `ENCRYPTION_KEY`. Set `PUBLIC_URL` to the Mac's HTTPS LAN URL. Run `npm install`, `npm run db:migrate`, and `npm run dev`. Next.js listens on port 3000.
2. Issue a certificate for the Mac's LAN name or IP using a local development CA such as `mkcert`. Keep its private key on the Mac. Put Caddy (or another HTTPS proxy) on the Mac in front of `127.0.0.1:3000`, serving the certificate for the exact `PUBLIC_URL` host.
3. Install that CA's **public root certificate** in Linux Mint's trust store using `/usr/local/share/ca-certificates/` and `sudo update-ca-certificates`. Verify `curl https://<Mac LAN name>/api/auth/me` succeeds without `-k` or `--insecure`.
4. On the Mac dashboard, register Linux Mint and generate a pairing token. On Linux Mint, install the agent using [agent installation](agent-installation.md), set `DEPLO_URL` to the same HTTPS LAN URL, and pair.
5. Build the NestJS example into a registry image or use a public test image. Create a project on the paired server, set its image, port, and health path, and deploy. For a local test domain, use a LAN DNS name resolvable by clients and the Linux server. Public ACME certificates require public DNS and reachability; use Caddy's trusted internal CA for LAN-only domains if configured separately.

For a single-machine loopback experiment only, `DEPLO_URL=http://127.0.0.1:3000` is allowed. That exception cannot connect Linux Mint to a separate Mac over the LAN.
