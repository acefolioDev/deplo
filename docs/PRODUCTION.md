# Deploy Deplo to production

This is the operator guide for the **Deplo control plane**. It runs the web app, PostgreSQL, and an HTTPS proxy on one Linux host. Managed application servers connect to it later; follow the [user guide](USER_GUIDE.md) for that step.

## 1. Prepare the host and domain

- Use a Linux host with Docker Engine and the Docker Compose plugin. Keep this host separate from the VPSs where users deploy applications.
- Point a DNS A record for your chosen name, such as `deplo.example.com`, to this host. Open inbound ports **80** and **443**. Nothing else should already be using those ports.
- Install Git and OpenSSL. Clone this repository and enter its root directory.

## 2. Create configuration and start

Run these commands from the repository root, replacing the domain:

```sh
bash scripts/init-production.sh deplo.example.com
docker compose up -d --build
docker compose ps
```

The setup script creates a private `.env` containing the database password, encryption key, and registration code. It refuses to overwrite an existing file. Compose starts PostgreSQL, applies Prisma migrations, starts the web app, and then starts Caddy for HTTPS. Keep `.env` backed up securely; losing `ENCRYPTION_KEY` makes stored deployment secrets unreadable.

Check the site:

```sh
curl -fsS https://deplo.example.com/api/auth/me
```

You should receive JSON with `"user":null`. If HTTPS is not ready, check DNS, ports 80/443, and `docker compose logs caddy web migrate`.

## 3. Create accounts

Open `https://deplo.example.com/register`. Give trusted developers the registration code from your `.env` file; they create their own accounts and sign in. Each account sees only its own servers, projects, and deployments. The code is required by this production stack, so an unrelated visitor cannot register. Deplo does not yet send email verification or password-reset messages; treat the code as an invite and share it privately.

To read the code on the control-plane host:

```sh
sed -n 's/^REGISTRATION_CODE=//p' .env
```

The developers then follow the [Deplo user guide](USER_GUIDE.md) to pair a VPS and deploy an image.

## Update and backup

From the repository root, after reviewing changes:

```sh
git pull
docker compose up -d --build
docker compose ps
```

The migration service applies new Prisma migrations before the web app starts. Existing Deplo databases created with the older SQL migration runner are detected and adopted without dropping their data. Take a database backup before the first upgrade:

```sh
docker compose exec -T db pg_dump -U deplo deplo > deplo-backup.sql
```

Back up `.env` alongside the database. Keep both files outside the host as well. `docker compose down` stops services but retains named database and Caddy volumes; **do not use** `docker compose down -v` unless you intend to remove their data.

## Current limits

The application and Prisma migration path pass local build and integration tests. This exact Compose stack and a real Linux Mint agent deployment still require a live production-host smoke test. Deplo is for trusted developers managing their own VPSs; it is not a hardened environment for untrusted tenants. Root terminal access is optional on each managed server and gives full host control to that server's account owner.
