# Deplo

**Deploy anywhere. Own everything.** Deplo is a web dashboard for deploying container images to your own Linux servers. Its agent connects outbound to the control plane, so you do not need to give the dashboard an SSH password.

## Start here

- [Deploy the Deplo control plane to production](docs/PRODUCTION.md) — for the person hosting Deplo.
- [Use Deplo](docs/USER_GUIDE.md) — for developers creating accounts, connecting servers, and deploying applications.

For a local preview on a Mac with PostgreSQL running, use `npm run demo` and open [http://localhost:3456](http://localhost:3456). The command creates a separate demo database and prints its account credentials. A remote VPS needs an HTTPS control-plane URL and cannot pair with this local HTTP preview.

## Repository

- `apps/web` — Next.js dashboard, API, and Prisma schema/migrations
- `agent` — Go agent for Docker deployments and optional root terminal access
- `scripts` — setup, migration, and demo commands
- `examples/nestjs` — sample image build and publication

## Development checks

Run `npm run build`, `npm run lint`, `npm run typecheck`, and `cd agent && go test ./...`. The API integration test needs a disposable PostgreSQL database named `deplo_test`: set `DEPLO_TEST_DATABASE_URL` and run `npm run test -w @deplo/web`. That test drops and recreates the database's `public` schema.
