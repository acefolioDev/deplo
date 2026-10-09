# Troubleshooting and recovery

- **Agent offline:** Check the systemd unit, `journalctl -u deplo-agent`, DNS, TLS trust, and `DEPLO_URL`. Do not bypass certificate verification. The dashboard marks a server disconnected when its last heartbeat is more than three minutes old.
- **Pairing rejected:** Tokens are single-use and expire after ten minutes. Generate a new token. If an agent has an identity file, remove it only after revoking the old credential in the dashboard.
- **Docker unavailable:** Check `docker info` and `/var/run/docker.sock` on the server. The service runs with host-level Docker authority. Do not expose the Docker socket over TCP.
- **Image pull failed:** Check reference, registry visibility, and the GHCR token scope. A Docker pull error should be reported on the deployment. Avoid storing token values in image names.
- **Health check failed:** Confirm the image listens on `0.0.0.0` at the configured internal port and responds at the configured path. The agent gives it 90 seconds. The old healthy container remains.
- **Domain not reachable:** Check A/AAAA records, ports 80/443, Caddy service logs, and whether the Caddyfile imports `/etc/caddy/deplo/*.caddy`. A `configured` status only means a route was accepted, not that a certificate was issued.
- **Job stuck:** An expired lease is available on the next agent poll; after five expired attempts it fails. If an agent performed an operation but could not report completion, the deterministic container name makes the retry target the same deployment. Inspect `deployment_jobs` and `deployments` before manual changes.
- **Control plane unavailable:** Existing Docker containers and Caddy routes keep serving. Restore PostgreSQL and the API; queued jobs resume when an agent polls.

Back up PostgreSQL with `pg_dump` and securely back up `ENCRYPTION_KEY` separately. Restore both to recover encrypted variables and GHCR credentials. Keep agent identity files on their respective servers. Do not restore a database into an unrelated control plane without reviewing credentials and DNS.

For long-lived control planes, prune old login rate-limit rows during regular database maintenance: `DELETE FROM login_attempts WHERE occurred_at < now() - interval '1 day';`. No resident cleanup worker is needed.
