# Deplo two-machine test plan

Use this runbook to test the current MVP on the development Mac (`192.168.0.102`) and Linux Mint laptop (`192.168.0.106`). Record each result before treating Deplo as ready for use. The full two-machine path has **not** been verified by the authoring session; the local build and API tests passed, while SSH authentication to Mint was unavailable. This plan uses a disposable Deplo database and a test application. It does not require Deplo to store an SSH password.

## 1. Prepare the Mac control plane

Requirements: Node 22, PostgreSQL 16+, npm, and this repository. Create a **new** database for the manual test. In `/Users/mac/Desktop/deplo`, copy `.env.example` to `.env.local`, then replace every placeholder. Use a unique database URL, `PUBLIC_URL=https://192.168.0.102`, a fresh bootstrap token from `openssl rand -hex 32`, and an encryption key from `openssl rand -base64 32`. Keep `.env.local` private. In each shell that runs Deplo, load it with:

```sh
cd /Users/mac/Desktop/deplo
set -a
source .env.local
set +a
npm install
npm run db:migrate
npm run build
npm run start -w @deplo/web
```

The last command keeps running. Confirm `curl -i http://127.0.0.1:3000/api/auth/me` returns HTTP 401 before login; that is the expected unauthenticated result. If the database already has an owner account, use that account instead of the bootstrap flow. Do not run the automated integration test against this database; it drops the `public` schema of the separate `deplo_test` database.

The agent requires trusted HTTPS for a remote control plane. Issue a certificate for the Mac's exact LAN IP or LAN DNS name with a local CA such as `mkcert`; put a TLS reverse proxy in front of `127.0.0.1:3000`. Set `PUBLIC_URL` to the same HTTPS origin used in the browser and agent. Install only the **public CA root** in Mint's trust store, then verify on Mint:

```sh
curl -i https://192.168.0.102/api/auth/me
```

HTTP 401 with no TLS error is success. Do not bypass verification with `curl -k` or an insecure agent setting. See [local development](local-development.md) for the TLS setup outline. If the Mac IP changes, update the certificate, `PUBLIC_URL`, and `DEPLO_URL` together.

## 2. Run automated checks

On the Mac, in a second shell:

```sh
cd /Users/mac/Desktop/deplo
npm run typecheck
npm run lint
npm run format:check
npm audit
cd agent && go test ./...
```

For the control-plane integration test, use a **disposable** PostgreSQL database literally named `deplo_test`. The test drops and recreates its `public` schema. If local PostgreSQL uses the Mac login role, this is an example:

```sh
createdb deplo_test
DEPLO_TEST_DATABASE_URL=postgres://mac@localhost:5432/deplo_test npm run test -w @deplo/web
```

Adjust the PostgreSQL role and host as needed. The expected result is one passing `control plane integration` test with no skips. The local test exercised auth, ownership, pairing, heartbeat, secret masking, leases, retries, deployment state, rotation, and revocation. A passing API suite does not replace the real Mint test below.

## 3. Prepare Mint without changing unrelated services

On Mint, record system details and check prerequisites:

```sh
cat /etc/os-release
uname -m
free -h
sudo docker version
sudo docker info
caddy version
systemctl status docker caddy --no-pager
```

Use a disposable Docker host or ensure the test will not disrupt other workloads. With the Mac control plane available over trusted HTTPS, register Mint in **Servers**, run the displayed setup command on Mint, then generate and paste the pairing token when prompted. The installer handles package checks, the Caddy import, binary verification, and systemd. The manual commands below are for troubleshooting or a custom installation.

For a manual Caddy setup, install Docker Engine and Caddy using their official packages if absent. Check the existing `/etc/caddy/Caddyfile`; add `import /etc/caddy/deplo/*.caddy` **outside** site blocks, preserving every existing entry. Then run:

```sh
sudo install -d -o root -g root -m 0755 /etc/caddy/deplo
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo systemctl reload caddy
```

The agent's root systemd service and root-only identity file are described in [agent installation](agent-installation.md). Build the Linux binary from this checkout or install a published release after checking its SHA256 checksum. For a local build on the Mac:

```sh
cd /Users/mac/Desktop/deplo/agent
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags='-s -w' -o /tmp/deplo-agent-linux-amd64 ./cmd/deplo-agent
shasum -a 256 /tmp/deplo-agent-linux-amd64
```

Transfer that binary and its recorded checksum to Mint using your trusted file-transfer method, verify `sha256sum`, and install it as `/usr/local/bin/deplo-agent` with root ownership and mode 0755. Use `GOARCH=arm64` if `uname -m` on Mint is `aarch64`.

## 4. Pair the agent

1. Open `https://192.168.0.102` in the browser. In **First time setup**, use the bootstrap token and create the owner account; then sign in.
2. In **Servers**, register `Mint test` with optional IP `192.168.0.106`. Run the displayed setup command on Mint. When it asks for a token, click **Pair token**; the token appears once and expires after ten minutes.
3. The installer creates `/etc/deplo-agent/agent.env`, installs the systemd service, pairs the agent, and removes the token from its environment file. If you use the manual path, follow [agent installation](agent-installation.md) instead.
4. Check `sudo journalctl -u deplo-agent -n 50 --no-pager` for `paired` and `agent started`.
5. Refresh **Servers**. Expected: **Online**, agent version and architecture, Docker available, Caddy ready, and nonempty host CPU/RAM/disk readings. Allow up to one heartbeat interval (two minutes). If Caddy says **not ready**, check its local admin API and import configuration.

Do not paste the pairing token, database URL, encryption key, or identity file into a bug report.

## 5. Deploy and exercise an application

1. In **Projects**, create `Mint smoke test` on the paired server. Select its **production** environment.
2. Set image `nginx:alpine`, internal port `80`, and health path `/`. Save settings, then click **Deploy**.
3. In **Deployments**, expect `queued` → `running` → `healthy` within the image pull and health-check timeouts. On Mint, use `sudo docker ps --filter label=com.deplo.managed=true` to find the new container. It must have a Deplo label and **no published host port**.
4. In **Projects**, request **Recent logs**. Expect a bounded, timestamped response or an empty result if the app has not produced logs. Use `docker logs` on Mint to compare if needed.
5. Add a nonsecret variable such as `DEMO_MODE=qa` and save. Confirm the dashboard shows a masked value on reload; redeploy, then inspect the new container environment on Mint to confirm it received the value. Do not use a real secret for this check.
6. Click **Restart** and verify the container returns to running. Click **Stop** and verify it stops. Deploy again and verify a new healthy deployment. Test **Redeploy digest** on an earlier healthy row if its immutable digest is shown.
7. Set a deliberately invalid image tag, save, and deploy. Expected: failed deployment with a useful error, while the previous healthy container remains available. Restore `nginx:alpine` afterward.
8. Create and deploy the **staging** environment separately. Confirm its container and deployment history are distinct from production.

For a domain test, use a hostname you control with DNS A/AAAA records pointing to the Mint server and reachable ports 80/443. Add it in **Projects**, redeploy, then check `curl -I https://<your-hostname>` and Caddy logs for a valid certificate and HTTP-to-HTTPS redirect. The dashboard's `configured` label means Caddy accepted the route; **it does not verify DNS or certificate issuance**. Skip this test if no suitable domain is available and record it as unverified.

## 6. Recovery and lightweight performance checks

- Stop the agent service briefly. The running application should remain available; **Servers** should eventually show Offline (allow for the heartbeat timeout). Restart the service and confirm Online returns.
- Restart the Mac control plane after a job is queued, then check that a pending job is eventually leased or an expired lease is retried without a duplicate managed container.
- Rotate the credential using `DEPLO_ROTATE_CREDENTIAL=1` as described in [agent installation](agent-installation.md). Confirm the agent reconnects, then remove the flag. Test **Revoke** only at the end; it deliberately prevents further jobs and requires a new pairing.
- Measure agent startup, idle RSS/CPU for ten minutes, and 30 cached-image deployments using the method in [performance](performance.md). Record actual values; do not infer them from binary size or the Mac API benchmark.

## Result sheet

| Check | Expected | Result / evidence |
| --- | --- | --- |
| Mac production build and API test | Build passes; integration test passes without skip | |
| Mint TLS trust | HTTPS request succeeds without insecure flags | |
| Pairing and heartbeat | Online; Docker/Caddy availability and host metrics shown | |
| First deployment | Healthy; labeled container; no public container port | |
| Variables and logs | Values masked in UI; bounded logs returned | |
| Restart, stop, digest redeploy | State matches each action | |
| Failed rollout | Failure recorded; prior healthy container preserved | |
| Production and staging | Separate deployment/container identities | |
| Domain and certificate, if configured | DNS resolves; HTTPS valid; redirect works | |
| Agent outage and recovery | App stays available; agent reconnects | |
| Rotation and revocation | Rotation reconnects; revocation blocks jobs | |
| Mint resource and timing measurements | Actual RSS, CPU, startup and deployment timings recorded | |

When a check fails, record the action, time, deployment ID, visible error, `journalctl -u deplo-agent` excerpt, Caddy error excerpt, and relevant Deplo deployment status. Redact tokens, cookies, environment values, and the identity credential before sharing. See [troubleshooting](troubleshooting.md).
