# Deploying applications

Create a project on a paired server. Each project starts with production and staging environments. Configure an OCI image, internal port, and HTTP health path in each environment. A successful health response is a 2xx or 3xx status. The container port is not published on the host; public ingress requires a domain and Caddy route.

Public images work without registry configuration. For a private GHCR image, set its `ghcr.io/...` reference, GHCR username, and a fine-scoped token in **Runtime options**. The token is encrypted in PostgreSQL and delivered only to the assigned agent on a leased job. Do not put the token in a URL or logs.

Set variables in the environment panel. Their values are write-only in normal API reads. They are injected at container creation, so save them before a deployment. A configured volume path mounts a Docker named volume `deplo-data-<environment UUID>` at that container path. Deplo never deletes named volumes during rollout. Database containers should be set up by the owner on private Docker networking; Deplo does not publish PostgreSQL or Redis ports.

Click **Deploy** after saving settings. The API creates a deployment and a job in a transaction. The agent polls for jobs, pulls the image, starts a new labeled container, checks health, updates its Caddy fragment, then stops and removes the previous labeled container. The old deployment remains if the new image fails readiness or route validation. A failed new container may remain for diagnosis. The agent reports progress and a final status to PostgreSQL. The dashboard's Deployments page displays the persisted status.

Use **Recent logs** for up to 200 timestamped lines and 32 KiB; it is a bounded retrieval job, not a live stream. Completed log jobs older than seven days are pruned when another log request arrives. **Restart** and **Stop** queue durable agent jobs. For an immutable rollback, use **Redeploy digest** in Deployment history or `POST /api/deployments/<id>/redeploy`; a previous image digest must have been recorded. Mutable image tags can change between deployments, so prefer digest references for release workflows.

Availability depends on image pull, health behavior, Caddy reload, and application shutdown. This release has not been tested for zero downtime. A deployment with no configured domain starts the container but does not expose it publicly.

## Example NestJS image

`examples/nestjs` serves `/health` and a root JSON response containing `MESSAGE` and `APP_VERSION`. Build locally with `docker build -t deplo-example:local examples/nestjs`. The included GitHub Actions workflow publishes `ghcr.io/<owner>/deplo-example:<commit SHA>` on pushes to `main`. Give the image a public package setting or configure GHCR credentials. Deploy a first tag, change `MESSAGE` or build a second commit, then deploy again to verify replacement and history.

For PostgreSQL, create a private user-managed Docker network and database container without `-p`; attach the application container to that network through a future controlled network option. The current agent creates containers on Docker's default bridge and does **not** yet support attaching them to a separate database network. This part of the example is documentation only, not a completed workflow.
