# Deplo

**Deploy anywhere. Own everything.** Deplo is a web dashboard for deploying container images to your own Linux servers. Its agent connects outbound to the control plane, so you do not need to give the dashboard an SSH password.

## Start here

- [Deploy the Deplo control plane to production](docs/PRODUCTION.md) — for the person hosting Deplo.
- [Use Deplo](docs/USER_GUIDE.md) — for developers creating accounts, connecting servers, and deploying applications.

The control plane is configured for Vercel and Neon. The production guide lists the exact project settings, environment variables, and migration command. A remote VPS needs the deployed HTTPS URL to pair its agent.

## Repository

- `apps/web` — Next.js dashboard, API, and Prisma schema/migrations
- `agent` — Go agent for Docker deployments and optional root terminal access
- `scripts` — migration and agent asset build commands

## Development checks

Run `npm run build`, `npm run lint`, `npm run typecheck`, and `cd agent && go test ./...`. The API integration test needs a disposable PostgreSQL database named `deplo_test`: set `DEPLO_TEST_DATABASE_URL` and run `npm run test -w @deplo/web`. That test drops and recreates the database's `public` schema.
