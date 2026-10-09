# Use Deplo

Your Deplo host gives you a HTTPS URL and, if registration is restricted, a registration code. Deplo runs your applications on a Linux VPS you control. You do not need to give Deplo an SSH password.

## 1. Create an account

Open your host's `/register` page, enter your email, a password of at least 12 characters, and the registration code if you received one. You are signed in immediately. Later, use `/login`.

## 2. Connect a server

Prepare an Ubuntu 24.04 or Linux Mint 22.2 Cinnamon VPS with `sudo` access and outbound HTTPS to your Deplo host. In **Servers**, choose **Register server** and give it a name. Its IP address is optional.

The **Connect a VPS** card displays one setup command. Caddy is selected when you want Deplo to serve public application domains over HTTPS; clear that checkbox if you only need private containers. Docker is required for Deplo's deployment engine. **Root terminal** is optional and off by default; select it only if you want full root command access from the dashboard.

Copy the command to a terminal on the VPS and run it. The installer verifies the agent binary, installs missing packages, and asks for a pairing token. While it waits, click **Pair token** for that server in Deplo and paste the token into the VPS terminal. Refresh **Servers** until the server says **Online**. The token expires after ten minutes and is removed from the agent configuration after pairing.

Your Deplo URL must use a trusted HTTPS certificate that the VPS accepts. A local HTTP development server cannot connect a remote VPS.

## 3. Deploy an application

1. In **Projects**, create a project and select your connected server. Deplo creates separate **production** and **staging** environments.
2. Choose an environment. Set its container image, internal port, and health path. For a first test, use image `nginx:alpine`, port `80`, and health path `/`.
3. Save the settings and click **Deploy**. Watch **Deployments** for `queued` → `running` → `healthy`. A new image must pass its health check before Deplo removes the previous container.
4. Use **Recent logs**, **Restart**, or **Stop** from the project controls when needed. A previously deployed immutable digest can be redeployed from deployment history.

Environment variables are saved encrypted; the dashboard shows their names but never returns stored plaintext values. If an image is private in GHCR, add its registry username and token in the environment settings. A configured volume path gives the container persistent data across redeployments.

## 4. Make an application public

Select Caddy during server setup. Point your application domain's DNS A/AAAA record at the managed VPS and make ports 80/443 reachable. Add the domain in the project's environment settings, then redeploy. Deplo updates Caddy's route; check the actual `https://` URL to confirm DNS and certificate issuance. A container without a domain stays private to the VPS and has no published host port.

## 5. Optional root terminal

If you enabled the root terminal when installing the agent, **Servers** shows a **Root terminal** button when that server is online. Re-enter your Deplo password to open it. Commands run as root, one session can be open per server, and the session expires after ten minutes. Select **Close session** when finished. To disable access, rerun the setup command with the root terminal checkbox cleared.

## If something does not work

- **Server offline:** Check the control-plane URL from the VPS with `curl`, then inspect `sudo journalctl -u deplo-agent -n 50 --no-pager` on the VPS. Make sure the certificate is trusted; do not use `curl -k`.
- **Deployment failed:** Read the error in **Deployments** and check the image name, port, and health path. The previous healthy container should remain in place after a failed replacement.
- **Domain not reachable:** Check DNS, open ports 80/443, and Caddy status on the VPS. The dashboard's `configured` status means Caddy accepted the route; it does not prove public certificate issuance.
- **Cannot sign in:** Ask your Deplo host for account help. This version has no email password reset.
