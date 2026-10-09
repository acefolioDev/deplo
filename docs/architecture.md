# Architecture

## Boundaries

The browser holds an HTTP-only session cookie. The Next.js API authorizes every user resource against the owner ID in PostgreSQL. The agent has a separate random bearer credential; only its hash is in PostgreSQL. It makes outbound HTTPS requests, never listens on a public port, and receives structured jobs instead of shell commands. The agent has privileged access to Docker and Caddy on one owner-controlled server.

The control plane persists deployments and jobs before returning to the browser. Agent polling uses a 2 to 30 second adaptive interval with jitter and a two-minute heartbeat. The heartbeat samples host usage and at most 20 managed containers; it does not run a continuous metrics stream. A lease lasts 15 minutes. A deployment operation has a 12-minute deadline. On expired leases, another poll can lease the job again, up to five attempts. A job with five expired attempts is failed. The deterministic `deplo-<deployment UUID>` container name makes repeated attempts target the same resource. PostgreSQL's partial unique index allows one queued or running deployment per environment.

## Deployment flow

The agent validates the structured specification, pulls the OCI image, creates a labeled container with a named persistent volume if configured, starts it, checks its HTTP health endpoint for up to 90 seconds, and updates a Deplo-owned Caddy site fragment. Only after Caddy accepts the configuration does it stop and remove the previous labeled deployment container. On a failed pull, start, health check, or route update, the old container and route remain. An unsuccessful new container can remain for inspection and a later idempotent retry; it can be removed manually only after confirming its Deplo labels. The named volume is never removed by rollout cleanup.

Applications stay up when the agent or control plane stops because Docker's `unless-stopped` policy and Caddy run independently. Job pickup waits for the control plane to return. With adaptive polling, pickup latency can approach 31 seconds while idle.

## Serverless compatibility

The Next.js API holds no durable in-memory queue or permanent socket. Vercel can host the control plane if its PostgreSQL networking, route limits, and environment variables are configured. The agent polls with HTTPS. Logs are bounded request/response jobs rather than a pretend live stream. A future dedicated gateway could add a WebSocket or gRPC transport around the same persisted job schema and Docker execution engine.

## Data

`users` and `sessions` authenticate the owner. `servers`, `pairing_tokens`, and `agent_credentials` establish agent identity. `projects` and `environments` hold runtime settings. `deployments` are historical rollouts. `deployment_jobs` are durable operations. `environment_variables` and optional GHCR credentials are AES-256-GCM ciphertext with a key held outside PostgreSQL. `domains` represent desired routes. `audit_logs` record privileged API operations. Migrations are in `packages/db/migrations`. The MVP supports one container service per environment, so it has no separate `services` table yet.

## Trade-offs

The single Next.js API is simpler to operate than a separate worker. Agent polling costs a small amount of traffic while idle; it also keeps serverless hosting possible. The agent uses Docker Engine's HTTP API through a Unix socket and Go's standard library. Caddy is a separate host service, and the operator adds one import statement to its Caddyfile so Deplo only edits its own site fragments. The dashboard uses small local UI primitives with Tailwind instead of the requested shadcn/ui component registry; adding the registry components remains a presentation task.
