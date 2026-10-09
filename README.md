# Deplo

**Deploy anywhere. Own everything.** Deplo is a hosted control plane for a trusted owner's Linux VPS. The Next.js dashboard and PostgreSQL database run separately; a small Go agent on each server leases jobs over outbound HTTPS and manages Docker containers.

## Try it on this Mac

With local PostgreSQL running, use `npm run demo`. The command creates a dedicated demo database, builds Deplo, creates a login, and starts it at [http://localhost:3456](http://localhost:3456). It prints the login credentials and keeps the app running until you press Ctrl+C. See the [short test guide](docs/quick-test.md). The command binds to localhost and does not alter other databases.

## Current state

The repository has a control-plane and agent implementation for account bootstrap, sign in, server pairing, heartbeat, project environments, encrypted variables, queued deployments, Docker image rollout, bounded logs, container stop/restart, and Caddy route updates. The API integration test covers pairing and job state transitions. The agent's real Docker lifecycle test is opt in; the development Mac does not have a running Docker daemon. The complete Mac-to-Linux-Mint workflow and Linux performance targets have **not** been verified yet. See [implementation status](docs/implementation-status.md), [performance](docs/performance.md), and [deployment](docs/deployment.md) for exact limits.

## Quick start

Requirements: Node 22, Go 1.26, PostgreSQL 16+, Docker Engine and Caddy on the managed Linux server.

1. Create a PostgreSQL database and copy `.env.example` to `.env.local`. Generate secrets with `openssl rand -base64 32` for `ENCRYPTION_KEY` and `openssl rand -hex 32` for `BOOTSTRAP_TOKEN`.
2. Export the same variables in your shell or load `.env.local` before running the migration: `npm install && npm run db:migrate`.
3. Run `npm run dev`, open the control plane URL, expand **First time setup**, and enter your bootstrap token to create the owner account. For a production build, run `npm run build` then `npm run start -w @deplo/web`; the start script copies static assets into Next.js's standalone output and starts its server.
4. Add a server, run the setup command shown in **Servers** on the VPS, and paste a pairing token when prompted. See [agent installation](docs/agent-installation.md) for the manual path.
5. Create a project, set a public OCI image such as `nginx:alpine` with port `80` and health path `/`, then deploy.

For an HTTPS LAN setup between Mac and Linux Mint, follow [local development](docs/local-development.md). The agent deliberately refuses a non-local HTTP control-plane URL.

## Repository

- `apps/web`: Next.js dashboard and API
- `packages/db/migrations`: explicit PostgreSQL migrations
- `agent`: standalone Go agent using the Docker Engine HTTP API over its Unix socket
- `examples/nestjs`: image build and GHCR publication example
- `docs`: architecture, security, deployment, installation, performance, and operations

## Tests

`npm run build` and `cd agent && go test ./...` run locally. To run the control-plane integration test, create a disposable database named `deplo_test`, then set `DEPLO_TEST_DATABASE_URL` and run `npm run test -w @deplo/web`. The test **drops and recreates the public schema** and refuses a database with another name. The real Docker lifecycle test requires `DEPLO_DOCKER_INTEGRATION=1` and should run only on a disposable Docker host; it creates and removes only a container labeled for its generated deployment ID. Follow the [two-machine test plan](docs/manual-test-plan.md) for pairing and deployment checks on Mac and Linux Mint.

## Operational boundary

This is a single-owner MVP. Docker socket access is host-level privilege; the agent is a privileged component. Do not use a Deplo server for untrusted multi-tenant workloads. Review [security](docs/security.md) before exposing a control plane or agent to the internet.
