# Implementation status — 2026-10-10

The repository is buildable and the control-plane integration test passes. The full two-machine workflow in the master brief is **not complete or verified**. Milestone reports below separate implemented code from verified behavior.

## Milestone 1 — Foundation

**Implemented:** npm workspace, strict TypeScript Next.js App Router dashboard, PostgreSQL migrations, owner bootstrap/login/logout and database sessions, Go agent skeleton, configuration examples, architecture and local development guides.

**Verified:** production Next.js build, TypeScript check, PostgreSQL migration, integration test bootstrap and authentication, Go compile and unit tests.

**Remaining:** configure and run the control plane on the actual Mac/LAN setup with the real Linux Mint host. The dashboard uses small local Tailwind components instead of shadcn/ui components.

## Milestone 2 — Pairing

**Implemented:** registered servers, hashed ten-minute single-use tokens, agent credential issuance, authenticated heartbeat, version/architecture/host usage report, revocation, a credential rotation API, and a guided Ubuntu/Mint installer served from the control plane.

**Verified:** API integration tests for token expiry and reuse, heartbeat, ownership, and revocation.

**Remaining:** run the guided installer, systemd pairing, and a live credential rotation on Linux Mint. The two-step rotation flow has an API integration test; the agent persistence path and installer have not run on that host.

## Milestone 3 — Deployment

**Implemented:** project creation with production/staging, configurable OCI image/port/health path/resource limits, database jobs and leases, Docker pull/create/start/stop/restart, deterministic labels and names, health checks, deployment history, immutable digest redeploy, retry on expired lease, and failure status. An optional real Docker lifecycle test is present.

**Verified:** control-plane job transitions, concurrent deployment rejection, lease expiry and replay rejection, agent specification validation and Go build.

**Remaining:** run the real Docker integration test and the full Mac-to-Linux Mint lifecycle. The CLI test was skipped because Docker Engine was unavailable on the development Mac. A bounded container CPU/RAM snapshot is implemented on the two-minute heartbeat, but its Linux overhead and the requested 30-second interval while viewing metrics are unverified/unimplemented. Deployment cancellation is not implemented.

## Milestone 4 — Production capabilities

**Implemented:** encrypted environment variables and GHCR token storage, named persistent Docker volume, Caddy fragment update with validation/reload, bounded recent logs, old-container preservation until health and route update, domain records, and dashboard controls.

**Verified:** API secret masking/encryption delivery and data validation tests. The Caddy update and GHCR pull paths compile but have not run on a real server.

**Remaining:** real DNS/certificate status checks, automatic route reconciliation after a domain change without redeploy, private Docker network attachment for user-managed databases, stronger cleanup reporting, and a true live log stream. Zero downtime is not claimed.

## Milestone 5 — Hardening and performance

**Implemented:** security and troubleshooting guides, request size limits, audit records, test database integration suite, opt-in real Docker lifecycle test, and a repeatable local API read benchmark.

**Verified:** local read endpoints' 100-request sequential measurements and zero reported npm audit vulnerabilities for both installed JavaScript dependency trees at the time of the run.

**Remaining:** full security review, Linux Mint idle RSS/CPU/startup/heartbeat benchmarks, API write-path and concurrency benchmarks, dashboard bundle/render measurements, deployment timing benchmarks, and failure drills with agent/control-plane outages.

## Definition of done check

Only the control-plane and agent code paths have been built and tested in this workspace. The required physical Linux Mint pairing, real image deployment, Caddy HTTPS issuance, logs from a real container, failure recovery, offline continuity, and agent resource measurements remain unverified. This is an incomplete MVP until those tests pass.
