# Test Deplo

## Try the dashboard on this Mac

1. In `/Users/mac/Desktop/deplo`, run `npm run demo`. Leave that terminal open.
2. Open `http://localhost:3456/login`. Sign in with the email and password printed by the command. On a later run, the same credentials are saved in the private `.deplo-local-demo.json` file.
3. Open **Servers** and register a test server. Check that it appears as **Unpaired**. Create a **Pair token** and check that it is displayed once.
4. Open **Projects** and **Deployments** to explore the dashboard. This local HTTP demo cannot pair a remote VPS; the agent requires a trusted HTTPS control-plane URL.

## Test a real Linux Mint 22.2 server

Prerequisite: run the control plane at a trusted HTTPS URL reachable from Mint. The setup command shown in the dashboard uses that URL. Use the full [two-machine test plan](manual-test-plan.md) if you need help preparing HTTPS.

1. In **Servers**, register the Mint laptop. Select **Enable root terminal in Deplo** if you want to test the terminal. Leave Caddy selected only if you want Deplo to manage public HTTPS domains.
2. Copy the displayed setup command and run it in a terminal on Mint. The installer installs Docker if needed, optionally installs Caddy, and pairs the agent. When prompted, generate **Pair token** in Deplo and paste it into Mint. You do not need to set up SSH keys for Deplo.
3. Refresh **Servers**. Expect **Online** and **Docker available**. If you selected the root terminal, expect a **Root terminal** button after the heartbeat.
4. Click **Root terminal**, enter your Deplo password again, and run `whoami`, `pwd`, and `uname -a`. Expect `root` from `whoami`. Try `exit`, then open a new session and select **Close session**. A session expires automatically after ten minutes.
5. In **Projects**, create a project on Mint. Set its production image to `nginx:alpine`, internal port to `80`, and health path to `/`. Deploy it. Expect **Healthy** in **Deployments**. Containers without a domain are private to the VPS and have no public host port.

If a step fails, copy the visible Deplo error and the last 50 agent log lines from `sudo journalctl -u deplo-agent -n 50 --no-pager` on Mint. Remove tokens and credentials before sharing logs.

The browser/API flows are covered by automated tests. A live Mint installation and root shell have not yet been verified from this workspace.
