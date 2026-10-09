# Agent installation

Supported target: Ubuntu 24.04 LTS and Linux Mint 22.2 Cinnamon on the Ubuntu 24.04 base, x86-64 or arm64. The agent uses the Docker Unix socket and Caddy CLI; its systemd service runs as root because both are host privileged in this MVP.

## Guided setup

First expose the control plane at a trusted HTTPS URL. Register a server in **Servers** and copy its setup command to a terminal on that VPS. The command downloads the installer from your own control plane and runs it with `sudo`. Review the downloaded script before running if you prefer. The installer:

1. Downloads the matching Linux agent binary and verifies its published SHA256 checksum.
2. Installs a missing `docker.io` package from the configured Ubuntu/Mint package repositories. Caddy is selected by default for public HTTPS domains; uncheck that option in **Servers** to add `--without-caddy` and skip the Caddy package.
3. When selected, adds one Deplo Caddy import without replacing unrelated Caddyfile entries, validates and reloads Caddy. It installs the agent as a restricted systemd service in either mode.
4. Prompts for a pairing token **after** packages are ready. At that prompt, click **Pair token** in the dashboard and paste the token. It is not placed in shell history. After pairing, the installer removes the one-time token from the root-only environment file.

Refresh **Servers** and check Online and Docker available; check Caddy ready if you selected it. If setup fails, the installer prints the relevant service log. Keep HTTPS certificate validation enabled. The manual procedure below remains available for hosts with existing custom Docker/Caddy installations or for operators who want each step under their control.

Without Caddy, Deplo can start and health-check images that have no domain configured. It does not publish a host port, so those containers are private to the VPS. Add a supported HTTPS router before configuring a public domain. The current domain integration supports Caddy only.

When releasing a new agent version, run `npm run agent:assets` in the repository before building the control plane. This rebuilds both Linux binaries and their `SHA256SUMS` file for the hosted installer.

### Optional root terminal

Check **Enable root terminal in Deplo** before copying the setup command to add `--enable-root-terminal`. This is off by default. The installer stores `DEPLO_ROOT_TERMINAL=1` in the root-only agent environment file and removes the service's filesystem restrictions so the terminal has full host control. Refresh **Servers** after the next heartbeat and select **Root terminal**. Re-enter the Deplo owner password to start a ten-minute shell. Only one shell can be open on a server at a time. Closing the browser does not immediately close the remote shell; select **Close session** when finished, or it expires after ten minutes.

To turn it off, rerun the setup command with the checkbox cleared. The installer removes the flag and reinstates the restricted service unit. Existing terminal sessions expire automatically; close one in Deplo first when possible.

## Manual installation

Install Docker Engine and Caddy from their official distribution instructions first. Verify `docker info` and `caddy version` before pairing. The root service identity is explicit rather than presenting Docker group access as a safe sandbox.

## Install a release

On the server, choose a published `agent-v*` release in this repository's GitHub Releases. Download `deplo-agent-linux-amd64` or `deplo-agent-linux-arm64` and `SHA256SUMS` from that exact release over HTTPS. Verify them before installing:

```sh
sha256sum -c --ignore-missing SHA256SUMS
sudo install -o root -g root -m 0755 deplo-agent-linux-amd64 /usr/local/bin/deplo-agent
```

The release workflow publishes checksums generated from the binaries in the same build. Verify the release URL and checksum source from a trusted account. Building from source with Go 1.26 is also supported: `cd agent && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags='-s -w' -o deplo-agent ./cmd/deplo-agent`.

## Prepare Caddy

Create the dedicated fragment directory, then add this single line to the existing `/etc/caddy/Caddyfile` **outside** all site blocks:

```caddyfile
import /etc/caddy/deplo/*.caddy
```

Do not remove unrelated Caddy configuration. Create the directory and validate the full config before reloading:

```sh
sudo install -d -o root -g root -m 0755 /etc/caddy/deplo
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

The agent writes only `/etc/caddy/deplo/<environment UUID>.caddy`. Caddy must listen on ports 80 and 443 for public HTTPS issuance. DNS A/AAAA records must point to the server. Deplo does not currently verify DNS or certificate issuance status.

## Pair and run

Generate a token in the Servers page. Put it in a root-only file on the server without entering it in shell history. Set `DEPLO_URL` to the real HTTPS control-plane URL, not localhost unless the control plane is on that same host:

```sh
sudo install -d -o root -g root -m 0700 /etc/deplo-agent /var/lib/deplo-agent
sudoedit /etc/deplo-agent/agent.env
sudo chmod 0600 /etc/deplo-agent/agent.env
```

The file contents on first start:

```ini
DEPLO_URL=https://control.example.com
DEPLO_PAIR_TOKEN=<one-time token from dashboard>
DEPLO_CREDENTIAL_FILE=/var/lib/deplo-agent/identity.json
```

Create `/etc/systemd/system/deplo-agent.service`:

```ini
[Unit]
Description=Deplo deployment agent
After=network-online.target docker.service caddy.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/deplo-agent/agent.env
ExecStart=/usr/local/bin/deplo-agent
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/deplo-agent /etc/caddy/deplo
ProtectHome=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=128M

[Install]
WantedBy=multi-user.target
```

Then run `sudo systemctl daemon-reload && sudo systemctl enable --now deplo-agent`. Check `sudo journalctl -u deplo-agent -n 50 --no-pager` and the server's online status in the dashboard. After pairing, remove `DEPLO_PAIR_TOKEN` from the environment file and restart the service. The resulting identity file must remain root-only; the agent writes it as mode 0600.

## Update, revoke, remove

To update, verify a new release checksum, stop the service, replace the binary, then start it. Existing identity remains in `/var/lib/deplo-agent/identity.json`. To rotate the agent credential, temporarily add `DEPLO_ROTATE_CREDENTIAL=1` to the root-only environment file and restart the service. The agent saves a pending replacement, confirms it with the control plane, and only then revokes the old credential. Remove the flag after the confirmation log entry. To revoke, use **Revoke** in the Servers page. To remove, stop and disable the service, delete its systemd unit and identity file, then remove the Deplo Caddy import and site fragments only if no applications depend on them. Do not remove Docker containers or named volumes without reviewing their Deplo labels and backing up application data.
