# Use Deplo

Your Deplo host gives you an HTTPS URL and, if registration is restricted, a registration code. Deplo connects to a Linux VPS you control. You do not need to give Deplo an SSH password.

## 1. Create an account

Open your host's `/register` page, enter your email, a password of at least 12 characters, and the registration code if you received one. You are signed in immediately. Later, use `/login`.

## 2. Connect a server

Prepare an Ubuntu 24.04 or Linux Mint 22.2 Cinnamon VPS with `sudo` access and outbound HTTPS to your Deplo host. In **Servers**, choose **Register server** and give it a name. Its IP address is optional.

The **Connect a VPS** card displays one setup command. It installs only the Deplo agent. Docker and Caddy are not required to connect the server. The root terminal is enabled by default so you can install software later from Deplo. It gives your Deplo account full root access to that VPS; clear the checkbox if you do not want this access.

Copy the command to a terminal on the VPS and run it. The installer verifies the agent binary and asks for a pairing token. While it waits, click **Pair token** for that server in Deplo and paste the token into the VPS terminal. Refresh **Servers** until the server says **Online**. The token expires after ten minutes and is removed from the agent configuration after pairing.

Your Deplo URL must use a trusted HTTPS certificate that the VPS accepts. A local HTTP development server cannot connect a remote VPS.

## 3. Add software when you need it

Open **Servers → Root terminal**, enter your Deplo password, and run commands on the connected VPS. The shell runs as root. You can use it for your own server setup without installing Docker.

When you decide to deploy a container image, install and start Docker from that terminal:

```sh
apt-get update
apt-get install -y docker.io
systemctl enable --now docker
docker info
```

Wait for the **Servers** page to show **Docker available**; the agent updates that status with its next heartbeat, within about two minutes. Deplo requires Docker only for container deployment and container management. Your server connection and root terminal continue working without it.

If you later want Deplo to manage public HTTPS domains, install Caddy from the same terminal and allow Deplo's routes in its configuration:

```sh
apt-get update
apt-get install -y caddy
install -d -m 0755 /etc/caddy/deplo
grep -Fxq 'import /etc/caddy/deplo/*.caddy' /etc/caddy/Caddyfile || printf '\nimport /etc/caddy/deplo/*.caddy\n' >> /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
systemctl enable --now caddy
systemctl reload caddy
```

Wait for **Caddy ready** on the server card before deploying an environment that has domains.

## 4. Deploy an application

1. In **Projects**, create a project and select your connected server. Deplo creates separate **production** and **staging** environments.
2. Choose an environment. Set its container image, internal port, and health path. For a first test, use image `nginx:alpine`, port `80`, and health path `/`.
3. Save the settings and click **Deploy**. Watch **Deployments** for `queued` → `running` → `healthy`. A new image must pass its health check before Deplo removes the previous container.
4. Use **Recent logs**, **Restart**, or **Stop** from the project controls when needed. A previously deployed immutable digest can be redeployed from deployment history.

Environment variables are saved encrypted; the dashboard shows their names but never returns stored plaintext values. If an image is private in GHCR, add its registry username and token in the environment settings. A configured volume path gives the container persistent data across redeployments.

## 5. Make an application public

Install Caddy when you need it, using the commands above. Point your application domain's DNS A/AAAA record at the managed VPS and make ports 80/443 reachable. Add the domain in the project's environment settings, then redeploy. Deplo updates Caddy's route; check the actual `https://` URL to confirm DNS and certificate issuance. A container without a domain stays private to the VPS and has no published host port.

## Root terminal access

**Servers** shows a **Root terminal** button when that server is online and terminal access was enabled during pairing. Re-enter your Deplo password to open it. One session can be open per server, and it expires after ten minutes. Select **Close session** when finished. To disable access, rerun the setup command with the root terminal checkbox cleared from a local terminal on the VPS.

## If something does not work

- **Server offline:** Check the control-plane URL from the VPS with `curl`, then inspect `sudo journalctl -u deplo-agent -n 50 --no-pager` on the VPS. Make sure the certificate is trusted; do not use `curl -k`.
- **Deployment failed:** Read the error in **Deployments** and check the image name, port, and health path. The previous healthy container should remain in place after a failed replacement.
- **Domain not reachable:** Check DNS, open ports 80/443, and Caddy status on the VPS. The dashboard's `configured` status means Caddy accepted the route; it does not prove public certificate issuance.
- **Cannot sign in:** Ask your Deplo host for account help. This version has no email password reset.
