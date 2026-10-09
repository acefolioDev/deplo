# Security model

Deplo assumes each managed server belongs to one trusted owner. Docker Engine access gives the agent effectively host-level privilege. Container restrictions reduce accidental exposure but are **not** a hardened sandbox for hostile tenants.

## Implemented controls

- Owner bootstrap requires a server-held random token; only one account may be bootstrapped.
- Passwords use salted scrypt. Sessions are random bearer values with hashes in PostgreSQL and HTTP-only, SameSite Strict cookies. HTTPS deployments set Secure cookies.
- Browser writes require an exact `Origin` matching `PUBLIC_URL` and its host. API resource queries enforce owner IDs. Login, bootstrap, and pairing attempts use a database-backed 15-minute rate limit.
- Pairing tokens are random, hashed in storage, single-use, and expire after ten minutes. Agent credentials are separately random, hashed, revocable, and rotatable. Agent transport validates TLS; insecure HTTP is accepted only for loopback development.
- Jobs use random lease secrets. Completion requires the current unexpired lease and is rejected after completion. Agent operations use structured specs, bounded input fields, Docker labels, and deterministic container names.
- Deployment variables and GHCR tokens use AES-256-GCM with `ENCRYPTION_KEY` outside PostgreSQL. Normal reads return variable names only. Database backups require a separate secured copy of the encryption key to restore secrets.
- The agent never exposes a public API. Deployment jobs use structured specs; Docker container creation rejects privileged, host-network, host PID, host mounts, devices, and extra capabilities. Application containers drop all Linux capabilities and set `no-new-privileges`.
- An optional root terminal is disabled by default. Enabling it explicitly in the installer removes the agent service's filesystem restrictions so the shell can administer the host. The owner must re-enter their password; each terminal lasts at most ten minutes, only one may be open per server, input and output chunks are bounded, and open/close events are audited. Commands and output are encrypted with the server-side key while buffered in PostgreSQL for browser polling and removed one day after session close. A compromised Deplo owner session plus password can control the host when this option is enabled.
- Caddy updates are restricted to Deplo site fragments. The agent checks for the configured import, validates the full Caddyfile, then reloads. It does not edit unrelated Caddy configuration.

## Known gaps before public production use

- The agent's Docker socket access remains host privileged. A compromised control-plane credential or agent can affect the VPS.
- This MVP has no multi-factor authentication, automated credential rotation schedule, or external security audit.
- The database rate-limit table needs periodic pruning in long-lived installations; no background janitor is installed.
- The API does not yet check DNS propagation or issued certificate state. A configured domain means Caddy accepted the route, not that TLS issuance succeeded.
- Authentication and configuration endpoints have an integration test, but the full Linux Mint end-to-end deployment has not been run in this workspace.

Do not place untrusted users' workloads on the same host. Protect `PUBLIC_URL`, `DATABASE_URL`, `BOOTSTRAP_TOKEN`, `ENCRYPTION_KEY`, and the agent identity file. Revoke an agent in the Servers page if the server or identity file is compromised.
