# Quick local test

Open [http://localhost:3456](http://localhost:3456) while the demo command is running, and sign in with the credentials it prints. To start it again later:

```sh
cd /Users/mac/Desktop/deplo
npm run demo
```

The command needs local PostgreSQL. It creates a separate `deplo_demo_*` database automatically, builds the web app, and prints a demo email and password. Press Ctrl+C to stop the server. A later run reuses the same demo database and credentials, stored in the Git-ignored `.deplo-local-demo.json` file. Keep that file private.

## What to click

1. **Overview:** Confirm the dashboard loads and shows its empty state.
2. **Servers:** Add a server called `Test server` with optional IP `192.168.0.106`. It should display **Unpaired**. Generate a **Pair token** and confirm it appears once with a ten-minute expiry. You do not need to install the agent for this UI check.
3. **Projects:** Create `Test project` on that server. Confirm production and staging appear. In production, save image `nginx:alpine`, port `80`, and health path `/`. Add a nonsecret variable and confirm the value is masked after saving.
4. **Deployments:** You can inspect the empty history. A real deployment needs the Mint agent connected, so leave **Deploy** until that setup is ready.
5. **Sign out**, then sign in again with the same credentials.

This is a dashboard and control-plane smoke test. The two-machine deployment test remains in [the full test plan](manual-test-plan.md). Its Linux, Docker, Caddy, HTTPS, and agent steps have not been run yet.
