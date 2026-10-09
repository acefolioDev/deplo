# Deploy Deplo with Vercel and Neon

This guide is for the person hosting the Deplo control plane. Vercel runs the dashboard and API; Neon stores its PostgreSQL data. Applications still run on developers' own Linux servers. Give those developers the [user guide](USER_GUIDE.md).

## 1. Create a Neon database

Create a Neon project in a region near the Vercel Function region you will use. In Neon's **Connect** dialog, copy the pooled PostgreSQL connection string (its hostname contains `-pooler`). Keep it private. Deplo uses this URL on Vercel, and current Neon pooling also supports Prisma migrations. You can use a separate direct connection string for migrations if you prefer.

## 2. Apply the database schema

From the repository root on a computer with Node.js 22, create a `.env` file with your Neon URL, then install dependencies and run the migration:

```dotenv
DATABASE_URL=postgresql://USER:PASSWORD@YOUR-POOLER-HOST/DATABASE?sslmode=require
```

```sh
npm ci
npm run db:migrate
```

The command reads `.env` automatically and applies the checked-in Prisma migrations. An optional `DIRECT_URL` takes precedence if you want migrations to use Neon's direct connection; copy that URL from Neon with pooling disabled. Shell variables override `.env`. Run the command again before each deployment that changes the schema. Do not run migrations as part of a Vercel build: a preview or retry could otherwise change the shared database. Keep `.env` out of Git.

For local testing, `npm run dev` also reads the repository root's `.env`. If it contains only `DIRECT_URL`, the dev command uses that URL as `DATABASE_URL` for the app. Vercel still needs `DATABASE_URL` set in its own environment settings.

## 3. Create the Vercel project

Push this repository to a Git provider and import it into Vercel. Set **Root Directory** to `apps/web`, **Framework Preset** to **Next.js**, and **Build Command** to `npm run build`. Choose Node.js 22 and a Function region near your Neon database. The app's build generates Prisma Client; it does not need to connect to Neon during the build.

Add these environment variables to the Vercel **Production** environment:

| Name | Value |
| --- | --- |
| `DATABASE_URL` | Neon **pooled** connection string, including its TLS settings |
| `ENCRYPTION_KEY` | New base64 key from `openssl rand -base64 32` |
| `REGISTRATION_CODE` | New invite code from `openssl rand -hex 24` |
| `PUBLIC_URL` | The exact HTTPS origin users will open, such as `https://deplo.example.com` |

`PUBLIC_URL` must have no trailing slash or path. If you use the Vercel-assigned `*.vercel.app` address, deploy once to see its exact URL, then set `PUBLIC_URL` and redeploy. Registration and other write actions require this variable. For a custom domain, connect it in Vercel, update DNS, and set `PUBLIC_URL` to that domain before using Deplo.

Keep `ENCRYPTION_KEY` stable across redeployments. Losing it makes stored deployment secrets unreadable. Share `REGISTRATION_CODE` only with developers you trust; there is no email verification or password reset yet. Configure Preview deployments with a separate Neon branch and a matching `PUBLIC_URL` if you intend to use them; do not point previews at the production database.

## 4. Verify and invite users

After deployment, visit `https://YOUR-DEPLO-HOST/api/auth/me`. It should return JSON with `"user":null`. Open `/register`, create your account using the registration code, and sign in. Give trusted developers the Deplo URL and code. They can then follow the [user guide](USER_GUIDE.md) to pair a VPS.

The server installer and its Linux agent binaries are served from the deployed site's `/agent/` path. Check that `https://YOUR-DEPLO-HOST/agent/install.sh` downloads before pairing a server. Pairing a VPS installs only the agent. Developers can later add Docker for container deployments and Caddy for public application domains from the Deplo terminal.

## Updates and backups

For a schema change, run `npm run db:migrate` before promoting the matching application version. Deploy the application through Vercel. Back up Neon data using its backup/restore options or `pg_dump` against a direct connection. Keep the encryption key in a separate secure backup.

Neon's free plan is useful for intermittent testing. A connected agent checks for jobs at least every 30 seconds, so it can prevent Neon's five-minute scale-to-zero and consume the free compute allowance even when no application deploys. Stop the agent between test sessions or plan for a paid database if you need it connected all month. Check actual usage in Neon and Vercel. Vercel Hobby is intended for personal, noncommercial use.

This Vercel and Neon deployment path is configured and passes local build and API tests, but needs a live deployment smoke test with your accounts and database.
