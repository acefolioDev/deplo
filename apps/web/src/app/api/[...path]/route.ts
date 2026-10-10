import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  relayPublish,
  serverChannel,
  terminalRelayAvailable,
} from "@/lib/terminal-relay";
import { pool, prisma, transaction } from "@/lib/db";
import {
  agentIdentity,
  cookieSettings,
  currentUser,
  decrypt,
  encrypt,
  hashPassword,
  safeEqual,
  secret,
  sha256,
  validOrigin,
  verifyPassword,
} from "@/lib/security";
import {
  hostname,
  HttpError,
  imageRef,
  object,
  optional,
  str,
  uuid,
} from "@/lib/validation";

export const runtime = "nodejs";
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
const requiredUser = async () => {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "Sign in required");
  return user;
};
const requiredAgent = async (request: Request) => {
  const agent = await agentIdentity(request);
  if (!agent) throw new HttpError(401, "Invalid agent credential");
  return agent;
};
async function body(request: Request) {
  const limit = new URL(request.url).pathname.startsWith("/api/agent/")
    ? 256 * 1024
    : 16 * 1024;
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Expected JSON body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(value);
  }
  try {
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid JSON body");
  }
}
async function audit(
  userId: string | null,
  serverId: string | null,
  action: string,
  resourceId: string | null,
) {
  await prisma.audit_logs.create({
    data: {
      user_id: userId,
      server_id: serverId,
      action,
      resource_id: resourceId,
    },
  });
}
async function ownedServer(id: string, userId: string) {
  const server = await prisma.servers.findFirst({
    where: { id, user_id: userId },
  });
  if (!server) throw new HttpError(404, "Server not found");
  return server;
}
async function ownedEnvironment(id: string, userId: string) {
  const environment = await prisma.environments.findFirst({
    where: { id, projects: { user_id: userId } },
    include: { projects: { select: { server_id: true, name: true } } },
  });
  if (!environment) throw new HttpError(404, "Environment not found");
  return {
    ...environment,
    server_id: environment.projects.server_id,
    project_name: environment.projects.name,
  };
}
async function requireDeploymentRuntime(
  serverId: string,
  environmentId: string,
  checkDomains = true,
) {
  const server = await prisma.servers.findUnique({
    where: { id: serverId },
    select: { docker_available: true, caddy_available: true },
  });
  if (!server?.docker_available)
    throw new HttpError(
      409,
      "Docker is not ready on this server. Install and start it from the Deplo root terminal before deploying.",
    );
  const domains = checkDomains
    ? await prisma.domains.count({ where: { environment_id: environmentId } })
    : 0;
  if (domains && !server.caddy_available)
    throw new HttpError(
      409,
      "Caddy is not ready on this server. Install and configure it before deploying an environment with domains.",
    );
}
async function rateLimit(key: string, maximum: number) {
  const hash = sha256(key);
  const count = await prisma.login_attempts.count({
    where: {
      key_hash: hash,
      occurred_at: { gt: new Date(Date.now() - 15 * 60 * 1000) },
    },
  });
  if (count >= maximum) throw new HttpError(429, "Too many attempts");
  await prisma.login_attempts.create({ data: { key_hash: hash } });
}
function terminalData(value: unknown, maxBytes: number) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil((maxBytes * 4) / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new HttpError(400, "Invalid terminal data");
  const bytes = Buffer.from(value, "base64");
  if (!bytes.length || bytes.length > maxBytes)
    throw new HttpError(400, "Invalid terminal data size");
  return value;
}
async function expireTerminals() {
  const now = new Date();
  const expired = await prisma.terminal_sessions.updateManyAndReturn({
    where: { status: { not: "closed" }, expires_at: { lte: now } },
    data: { status: "closed", closed_at: now },
    select: { id: true, user_id: true, server_id: true },
  });
  for (const x of expired)
    await audit(x.user_id, x.server_id, "root_terminal.expire", x.id);
  await prisma.terminal_sessions.deleteMany({
    where: {
      status: "closed",
      closed_at: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },
    },
  });
}

async function handle(request: NextRequest, path: string[], method: string) {
  const p = path;
  const agentRoute = p[0] === "agent";
  if (method !== "GET" && !agentRoute && !(await validOrigin(request)))
    throw new HttpError(403, "Invalid request origin");

  if (p[0] === "auth") {
    if (p[1] === "me" && method === "GET")
      return json({ user: await currentUser() });
    if (p[1] === "register" && method === "POST") {
      const b = await body(request);
      const email = str(b.email, "email", 254).toLowerCase();
      const password = str(b.password, "password", 256);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 12)
        throw new HttpError(
          400,
          "Use a valid email and a password of at least 12 characters",
        );
      await rateLimit(`register:${email}`, 5);
      if (process.env.REGISTRATION_CODE) {
        const code =
          typeof b.registrationCode === "string" ? b.registrationCode : "";
        if (!safeEqual(code, process.env.REGISTRATION_CODE))
          throw new HttpError(403, "Invalid registration code");
      }
      const passwordHash = await hashPassword(password);
      const token = secret();
      const user = await prisma.$transaction(async (db) => {
        const created = await db.users.create({
          data: { email, password_hash: passwordHash },
          select: { id: true, email: true },
        });
        await db.sessions.create({
          data: {
            user_id: created.id,
            token_hash: sha256(token),
            expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        });
        return created;
      });
      await audit(user.id, null, "account.register", user.id);
      (await cookies()).set("deplo_session", token, cookieSettings());
      return json({ user }, 201);
    }
    if (p[1] === "login" && method === "POST") {
      const b = await body(request);
      const email = str(b.email, "email", 254).toLowerCase();
      const password = str(b.password, "password", 256);
      await rateLimit(`login:${email}`, 10);
      const account = await prisma.users.findUnique({
        where: { email },
        select: { id: true, email: true, password_hash: true },
      });
      if (!account || !(await verifyPassword(password, account.password_hash)))
        throw new HttpError(401, "Invalid credentials");
      const token = secret();
      await prisma.sessions.create({
        data: {
          user_id: account.id,
          token_hash: sha256(token),
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });
      (await cookies()).set("deplo_session", token, cookieSettings());
      return json({ user: { id: account.id, email } });
    }
    if (p[1] === "logout" && method === "POST") {
      const token = (await cookies()).get("deplo_session")?.value;
      if (token)
        await prisma.sessions.deleteMany({
          where: { token_hash: sha256(token) },
        });
      (await cookies()).delete("deplo_session");
      return json({ ok: true });
    }
  }

  if (agentRoute) {
    if (p[1] === "pair" && method === "POST") {
      const b = await body(request);
      const token = str(b.token, "pairing token", 256);
      await rateLimit(`pair:${sha256(token)}`, 5);
      const credential = secret();
      const serverId = await transaction(async (c) => {
        const r = await c.query(
          `SELECT pt.server_id FROM pairing_tokens pt JOIN servers s ON s.id=pt.server_id
          WHERE pt.token_hash=$1 AND pt.consumed_at IS NULL AND pt.expires_at>now() AND s.status<>'revoked' FOR UPDATE OF pt`,
          [sha256(token)],
        );
        if (!r.rowCount)
          throw new HttpError(401, "Invalid or expired pairing token");
        await c.query(
          "UPDATE pairing_tokens SET consumed_at=now() WHERE token_hash=$1",
          [sha256(token)],
        );
        await c.query(
          "INSERT INTO agent_credentials(server_id,token_hash) VALUES($1,$2)",
          [r.rows[0].server_id, sha256(credential)],
        );
        await c.query("UPDATE servers SET status='offline' WHERE id=$1", [
          r.rows[0].server_id,
        ]);
        return r.rows[0].server_id as string;
      });
      await audit(null, serverId, "agent.pair", serverId);
      return json({ serverId, credential }, 201);
    }
    const agent = await requiredAgent(request);
    if (agent.pending && !(p[1] === "confirm-rotation" && method === "POST"))
      throw new HttpError(401, "Credential rotation must be confirmed");
    if (p[1] === "heartbeat" && method === "POST") {
      const b = await body(request);
      const metrics = object(b.metrics);
      const number = (value: unknown) => {
        const n = Number(value);
        return Number.isFinite(n) && n >= 0 ? n : 0;
      };
      const rawContainers = Array.isArray(metrics.containers)
        ? metrics.containers
        : [];
      if (rawContainers.length > 20)
        throw new HttpError(400, "Too many container metrics");
      const containers = rawContainers.map((value) => {
        const item = object(value);
        return {
          deploymentId: uuid(item.deploymentId),
          status: str(item.status, "container status", 20),
          cpuPercent: number(item.cpuPercent),
          memoryUsed: number(item.memoryUsed),
          memoryLimit: number(item.memoryLimit),
        };
      });
      const validated = {
        cpuPercent: number(metrics.cpuPercent),
        memoryUsed: number(metrics.memoryUsed),
        memoryTotal: number(metrics.memoryTotal),
        diskUsed: number(metrics.diskUsed),
        diskTotal: number(metrics.diskTotal),
        containers,
      };
      await prisma.servers.update({
        where: { id: agent.server_id },
        data: {
          status: "online",
          last_seen_at: new Date(),
          agent_version: str(b.version, "version", 64),
          docker_available: b.dockerAvailable === true,
          caddy_available: b.caddyAvailable === true,
          metrics: validated,
          architecture: b.architecture
            ? str(b.architecture, "architecture", 32)
            : null,
          terminal_available: b.terminalAvailable === true,
        },
      });
      if (b.terminalAvailable !== true) {
        const closed = await prisma.terminal_sessions.updateManyAndReturn({
          where: { server_id: agent.server_id, status: { not: "closed" } },
          data: { status: "closed", closed_at: new Date() },
          select: { id: true, user_id: true },
        });
        for (const x of closed)
          await audit(
            x.user_id,
            agent.server_id,
            "root_terminal.disabled",
            x.id,
          );
      }
      return json({ ok: true });
    }
    if (p[1] === "terminal" && p[2] === "poll" && method === "POST") {
      const b = await body(request);
      const outputSessionId =
        b.sessionId === undefined ? null : uuid(b.sessionId);
      const data =
        b.data === undefined || b.data === "" ? "" : terminalData(b.data, 8192);
      const closed = b.closed === true;
      if ((data || closed) && !outputSessionId)
        throw new HttpError(400, "Terminal session ID required");
      const result = await transaction(async (c) => {
        let closedSessionId: string | null = null;
        if (outputSessionId && (data || closed)) {
          const active = await c.query(
            "SELECT id FROM terminal_sessions WHERE id=$1 AND server_id=$2 AND status='active' AND expires_at>now() FOR UPDATE",
            [outputSessionId, agent.server_id],
          );
          if (active.rowCount) {
            if (data) {
              await c.query(
                "INSERT INTO terminal_outputs(session_id,data) VALUES($1,$2)",
                [outputSessionId, encrypt(data)],
              );
              await c.query(
                "DELETE FROM terminal_outputs WHERE session_id=$1 AND id NOT IN (SELECT id FROM terminal_outputs WHERE session_id=$1 ORDER BY id DESC LIMIT 32)",
                [outputSessionId],
              );
            }
            if (closed) {
              await c.query(
                "UPDATE terminal_sessions SET status='closed',closed_at=now() WHERE id=$1",
                [outputSessionId],
              );
              closedSessionId = outputSessionId;
            }
          }
        }
        const sessions = await c.query(
          "SELECT id,status,expires_at,cols,rows FROM terminal_sessions WHERE server_id=$1 AND status IN ('pending','active') AND expires_at>now() ORDER BY created_at LIMIT 1 FOR UPDATE",
          [agent.server_id],
        );
        if (!sessions.rowCount) return { session: null, closedSessionId };
        const session = sessions.rows[0];
        if (session.status === "pending")
          await c.query(
            "UPDATE terminal_sessions SET status='active' WHERE id=$1",
            [session.id],
          );
        const inputs = await c.query(
          "DELETE FROM terminal_inputs WHERE id IN (SELECT id FROM terminal_inputs WHERE session_id=$1 ORDER BY id LIMIT 32 FOR UPDATE SKIP LOCKED) RETURNING id,data",
          [session.id],
        );
        return {
          session: {
            id: session.id,
            expiresAt: session.expires_at,
            cols: session.cols,
            rows: session.rows,
            inputs: inputs.rows
              .sort((a, b) => Number(a.id) - Number(b.id))
              .map((x) => decrypt(x.data)),
          },
          closedSessionId,
        };
      });
      if (result.closedSessionId)
        await audit(
          null,
          agent.server_id,
          "root_terminal.process_exit",
          result.closedSessionId,
        );
      return json({ session: result.session });
    }
    if (p[1] === "terminal" && p[2] === "output" && method === "POST") {
      const b = await body(request);
      const sessionId = uuid(b.sessionId);
      const data = b.data === "" ? "" : terminalData(b.data, 8192);
      const closed = b.closed === true;
      await transaction(async (c) => {
        const r = await c.query(
          "SELECT id FROM terminal_sessions WHERE id=$1 AND server_id=$2 AND status='active' AND expires_at>now() FOR UPDATE",
          [sessionId, agent.server_id],
        );
        if (!r.rowCount) throw new HttpError(409, "Terminal session closed");
        if (data) {
          await c.query(
            "INSERT INTO terminal_outputs(session_id,data) VALUES($1,$2)",
            [sessionId, encrypt(data)],
          );
          await c.query(
            "DELETE FROM terminal_outputs WHERE session_id=$1 AND id NOT IN (SELECT id FROM terminal_outputs WHERE session_id=$1 ORDER BY id DESC LIMIT 32)",
            [sessionId],
          );
        }
        if (closed)
          await c.query(
            "UPDATE terminal_sessions SET status='closed',closed_at=now() WHERE id=$1",
            [sessionId],
          );
      });
      if (closed)
        await audit(
          null,
          agent.server_id,
          "root_terminal.process_exit",
          sessionId,
        );
      return json({ ok: true });
    }
    if (p[1] === "rotate" && method === "POST") {
      const credential = secret();
      await prisma.agent_credentials.create({
        data: {
          server_id: agent.server_id,
          token_hash: sha256(credential),
          pending: true,
        },
      });
      await audit(null, agent.server_id, "agent.rotate", agent.id);
      return json({ credential });
    }
    if (p[1] === "confirm-rotation" && method === "POST") {
      if (agent.pending)
        await transaction(async (c) => {
          const updated = await c.query(
            "UPDATE agent_credentials SET pending=false,expires_at=NULL WHERE id=$1 AND pending=true RETURNING id",
            [agent.id],
          );
          if (!updated.rowCount) throw new HttpError(409, "Rotation expired");
          await c.query(
            "UPDATE agent_credentials SET revoked_at=now() WHERE server_id=$1 AND id<>$2 AND revoked_at IS NULL",
            [agent.server_id, agent.id],
          );
        });
      await audit(null, agent.server_id, "agent.rotation_confirmed", agent.id);
      return json({ ok: true });
    }
    if (p[1] === "jobs" && p[2] === "lease" && method === "POST") {
      const lease = secret();
      const job = await transaction(async (c) => {
        const exhausted = await c.query(
          `UPDATE deployment_jobs SET status='failed',error='Agent lease expired after five attempts',finished_at=now(),lease_hash=NULL
          WHERE server_id=$1 AND status='leased' AND lease_expires_at<now() AND attempt>=5 RETURNING deployment_id`,
          [agent.server_id],
        );
        for (const row of exhausted.rows)
          if (row.deployment_id)
            await c.query(
              "UPDATE deployments SET status='failed',message='Agent lease expired after five attempts',finished_at=now() WHERE id=$1",
              [row.deployment_id],
            );
        const r = await c.query(
          `SELECT * FROM deployment_jobs WHERE server_id=$1 AND
          (status='pending' OR (status='leased' AND lease_expires_at<now())) AND attempt<5
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
          [agent.server_id],
        );
        if (!r.rowCount) return null;
        const j = r.rows[0];
        await c.query(
          `UPDATE deployment_jobs SET status='leased',attempt=attempt+1,lease_hash=$2,lease_expires_at=now()+interval '15 minutes' WHERE id=$1`,
          [j.id, sha256(lease)],
        );
        if (j.deployment_id)
          await c.query(
            "UPDATE deployments SET status='running',started_at=coalesce(started_at,now()),message='Agent accepted job' WHERE id=$1",
            [j.deployment_id],
          );
        return j;
      });
      if (!job) return json({ job: null });
      const [env, vars, domains] = await Promise.all([
        prisma.environments.findUniqueOrThrow({
          where: { id: job.environment_id },
        }),
        prisma.environment_variables.findMany({
          where: { environment_id: job.environment_id },
          select: { name: true, ciphertext: true },
        }),
        prisma.domains.findMany({
          where: { environment_id: job.environment_id },
          select: { hostname: true },
        }),
      ]);
      return json({
        job: {
          id: job.id,
          kind: job.kind,
          deploymentId: job.deployment_id,
          lease,
          environmentId: job.environment_id,
          imageRef: job.payload.imageRef ?? env.image_ref,
          port: env.container_port,
          memoryMb: env.memory_mb,
          cpuQuota: env.cpu_quota,
          healthPath: env.health_path,
          volumePath: env.volume_path,
          registryUsername: env.registry_username,
          registryToken: env.registry_token_ciphertext
            ? decrypt(env.registry_token_ciphertext)
            : null,
          previousDeploymentId: env.active_deployment_id,
          variables: Object.fromEntries(
            vars.map((v) => [v.name, decrypt(v.ciphertext)]),
          ),
          domains: domains.map((d) => d.hostname),
        },
      });
    }
    if (p[1] === "jobs" && p[2] && p[3] === "complete" && method === "POST") {
      const jobId = uuid(p[2]);
      const b = await body(request);
      const lease = str(b.lease, "lease", 256);
      const status = b.success === true ? "done" : "failed";
      await transaction(async (c) => {
        const r = await c.query(
          `SELECT * FROM deployment_jobs WHERE id=$1 AND server_id=$2 AND status='leased' AND lease_hash=$3 AND lease_expires_at>now() FOR UPDATE`,
          [jobId, agent.server_id, sha256(lease)],
        );
        if (!r.rowCount)
          throw new HttpError(409, "Lease expired or already completed");
        const j = r.rows[0];
        const message = optional(b.message, "message", 1000);
        const imageDigest = optional(b.imageDigest, "image digest", 512);
        const result =
          b.result && typeof b.result === "object"
            ? JSON.stringify(b.result)
            : null;
        if (result && result.length > 200 * 1024)
          throw new HttpError(413, "Job result too large");
        await c.query(
          "UPDATE deployment_jobs SET status=$2,error=$3,result=$4,finished_at=now(),lease_hash=NULL WHERE id=$1",
          [jobId, status, status === "failed" ? message : null, result],
        );
        if (j.deployment_id) {
          await c.query(
            `UPDATE deployments SET status=$2,message=$3,image_digest=$4,finished_at=now() WHERE id=$1`,
            [
              j.deployment_id,
              status === "done" ? "healthy" : "failed",
              message,
              imageDigest,
            ],
          );
          if (status === "done") {
            await c.query(
              "UPDATE environments SET active_deployment_id=$2,runtime_status='running' WHERE id=$1",
              [j.environment_id, j.deployment_id],
            );
            await c.query(
              "UPDATE domains SET status='configured' WHERE environment_id=$1",
              [j.environment_id],
            );
          }
        }
        if (status === "done" && j.kind === "stop")
          await c.query(
            "UPDATE environments SET runtime_status='stopped' WHERE id=$1",
            [j.environment_id],
          );
        if (status === "done" && j.kind === "restart")
          await c.query(
            "UPDATE environments SET runtime_status='running' WHERE id=$1",
            [j.environment_id],
          );
      });
      await audit(null, agent.server_id, `job.${status}`, jobId);
      return json({ ok: true });
    }
    if (p[1] === "jobs" && p[2] && p[3] === "progress" && method === "POST") {
      const b = await body(request);
      const lease = str(b.lease, "lease", 256);
      const message = str(b.message, "progress", 120);
      const r = await pool.query(
        `UPDATE deployments d SET message=$4 FROM deployment_jobs j WHERE j.id=$1 AND j.server_id=$2 AND j.lease_hash=$3 AND j.status='leased' AND j.lease_expires_at>now() AND d.id=j.deployment_id RETURNING d.id`,
        [uuid(p[2]), agent.server_id, sha256(lease), message],
      );
      if (!r.rowCount)
        throw new HttpError(409, "Lease expired or no deployment");
      return json({ ok: true });
    }
    throw new HttpError(404, "Agent endpoint not found");
  }

  const user = await requiredUser();
  if (p[0] === "overview" && method === "GET") {
    const [servers, apps, deployments] = await Promise.all([
      prisma.servers.count({ where: { user_id: user.id } }),
      prisma.environments.count({
        where: { runtime_status: "running", projects: { user_id: user.id } },
      }),
      prisma.deployments.findMany({
        where: {
          environments_deployments_environment_idToenvironments: {
            projects: { user_id: user.id },
          },
        },
        orderBy: { created_at: "desc" },
        take: 8,
        select: {
          id: true,
          status: true,
          image_ref: true,
          created_at: true,
          environments_deployments_environment_idToenvironments: {
            select: { name: true, projects: { select: { name: true } } },
          },
        },
      }),
    ]);
    return json({
      servers,
      applications: apps,
      recentDeployments: deployments.map((d) => ({
        id: d.id,
        status: d.status,
        image_ref: d.image_ref,
        created_at: d.created_at,
        project:
          d.environments_deployments_environment_idToenvironments.projects.name,
        environment:
          d.environments_deployments_environment_idToenvironments.name,
      })),
    });
  }
  if (p[0] === "servers") {
    if (p.length === 1 && method === "GET") {
      const servers = await prisma.servers.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: "desc" },
        select: {
          id: true,
          name: true,
          ip: true,
          description: true,
          status: true,
          agent_version: true,
          architecture: true,
          docker_available: true,
          caddy_available: true,
          terminal_available: true,
          metrics: true,
          last_seen_at: true,
          created_at: true,
        },
      });
      return json({
        servers: servers.map((server) => ({
          ...server,
          connected:
            server.status === "online" &&
            !!server.last_seen_at &&
            server.last_seen_at.getTime() > Date.now() - 180000,
        })),
      });
    }
    if (p.length === 1 && method === "POST") {
      const b = await body(request);
      const name = str(b.name, "name", 80);
      const server = await prisma.servers.create({
        data: {
          user_id: user.id,
          name,
          ip: optional(b.ip, "IP address", 64),
          description: optional(b.description, "description", 500),
        },
        select: { id: true, name: true, status: true },
      });
      await audit(user.id, server.id, "server.create", server.id);
      return json({ server }, 201);
    }
    if (p[1]) {
      const server = await ownedServer(uuid(p[1]), user.id);
      if (p[2] === "terminal") {
        await expireTerminals();
        if (p.length === 3 && method === "POST") {
          if (
            !server.terminal_available ||
            server.status !== "online" ||
            !server.last_seen_at ||
            Date.now() - new Date(server.last_seen_at).getTime() > 180000
          )
            throw new HttpError(
              409,
              "Root terminal is unavailable on this server",
            );
          const b = await body(request);
          await rateLimit(`terminal:${user.id}`, 5);
          const password = str(b.password, "password", 256);
          const owner = await prisma.users.findUnique({
            where: { id: user.id },
            select: { password_hash: true },
          });
          if (!owner || !(await verifyPassword(password, owner.password_hash)))
            throw new HttpError(401, "Incorrect password");
          const session = await prisma.terminal_sessions.create({
            data: {
              server_id: server.id,
              user_id: user.id,
              expires_at: new Date(Date.now() + 10 * 60 * 1000),
            },
            select: { id: true, expires_at: true },
          });
          await audit(user.id, server.id, "root_terminal.open", session.id);
          return json(
            {
              sessionId: session.id,
              expiresAt: session.expires_at,
              transport:
                terminalRelayAvailable() &&
                /^0\.1\.[2-9]\d*$/.test(server.agent_version ?? "")
                  ? "websocket"
                  : "http",
            },
            201,
          );
        }
        if (p[3]) {
          const sessionId = uuid(p[3]);
          const session = await prisma.terminal_sessions.findFirst({
            where: { id: sessionId, server_id: server.id, user_id: user.id },
            select: { id: true, status: true, expires_at: true },
          });
          if (!session) throw new HttpError(404, "Terminal session not found");
          if (p.length === 4 && method === "GET") {
            const params = new URL(request.url).searchParams;
            const after = Number(params.get("after") ?? "0");
            if (!Number.isSafeInteger(after) || after < 0)
              throw new HttpError(400, "Invalid output cursor");
            const deadline =
              params.get("wait") === "1" ? Date.now() + 2000 : Date.now();
            let output;
            do {
              output = await prisma.terminal_outputs.findMany({
                where: { session_id: sessionId, id: { gt: BigInt(after) } },
                orderBy: { id: "asc" },
                take: 50,
                select: { id: true, data: true },
              });
              if (
                output.length ||
                session.status === "closed" ||
                Date.now() >= deadline ||
                Date.now() >= session.expires_at.getTime()
              )
                break;
              await new Promise((resolve) => setTimeout(resolve, 150));
            } while (true);
            let status = session.status;
            if (
              status !== "closed" &&
              Date.now() >= session.expires_at.getTime()
            ) {
              await expireTerminals();
              status = "closed";
            } else if (params.get("wait") === "1" && !output.length) {
              const latest = await prisma.terminal_sessions.findUnique({
                where: { id: sessionId },
                select: { status: true },
              });
              status = latest?.status ?? "closed";
            }
            return json({
              status,
              expiresAt: session.expires_at,
              output: output.map((x) => ({
                id: x.id.toString(),
                data: decrypt(x.data),
              })),
            });
          }
          if (p[4] === "input" && method === "POST") {
            const b = await body(request);
            const data = terminalData(b.data, 4096);
            await transaction(async (c) => {
              const active = await c.query(
                "SELECT id FROM terminal_sessions WHERE id=$1 AND status IN ('pending','active') AND expires_at>now() FOR UPDATE",
                [sessionId],
              );
              if (!active.rowCount)
                throw new HttpError(409, "Terminal session closed");
              const queued = await c.query(
                "SELECT count(*)::int AS count FROM terminal_inputs WHERE session_id=$1",
                [sessionId],
              );
              if (queued.rows[0].count >= 128)
                throw new HttpError(429, "Terminal input queue is full");
              await c.query(
                "INSERT INTO terminal_inputs(session_id,data) VALUES($1,$2)",
                [sessionId, encrypt(data)],
              );
            });
            return json({ ok: true });
          }
          if (p[4] === "resize" && method === "POST") {
            const b = await body(request);
            const cols = Number(b.cols);
            const rows = Number(b.rows);
            if (
              !Number.isInteger(cols) ||
              cols < 20 ||
              cols > 300 ||
              !Number.isInteger(rows) ||
              rows < 5 ||
              rows > 100
            )
              throw new HttpError(400, "Invalid terminal size");
            const resized = await prisma.terminal_sessions.updateMany({
              where: {
                id: sessionId,
                status: { in: ["pending", "active"] },
                expires_at: { gt: new Date() },
              },
              data: { cols, rows },
            });
            if (!resized.count)
              throw new HttpError(409, "Terminal session closed");
            return json({ ok: true });
          }
          if (p[4] === "close" && method === "POST") {
            const closed = await prisma.$transaction(async (db) => {
              const changed = await db.terminal_sessions.updateMany({
                where: { id: sessionId, status: { not: "closed" } },
                data: { status: "closed", closed_at: new Date() },
              });
              await db.terminal_inputs.deleteMany({
                where: { session_id: sessionId },
              });
              return changed.count;
            });
            if (closed)
              await audit(user.id, server.id, "root_terminal.close", sessionId);
            if (closed && terminalRelayAvailable())
              await relayPublish(serverChannel(server.id), {
                type: "close",
                sessionId,
              }).catch(() => {});
            return json({ ok: true });
          }
        }
      }
      if (p[2] === "pair" && method === "POST") {
        const token = secret();
        await prisma.pairing_tokens.create({
          data: {
            server_id: server.id,
            token_hash: sha256(token),
            expires_at: new Date(Date.now() + 10 * 60 * 1000),
          },
        });
        await audit(user.id, server.id, "server.pair_token", server.id);
        return json({ token, expiresInSeconds: 600 });
      }
      if (p[2] === "revoke" && method === "POST") {
        const closed = await prisma.$transaction(async (db) => {
          const now = new Date();
          await db.agent_credentials.updateMany({
            where: { server_id: server.id },
            data: { revoked_at: now },
          });
          await db.servers.update({
            where: { id: server.id },
            data: { status: "revoked" },
          });
          return db.terminal_sessions.updateManyAndReturn({
            where: { server_id: server.id, status: { not: "closed" } },
            data: { status: "closed", closed_at: now },
            select: { id: true },
          });
        });
        for (const x of closed)
          await audit(user.id, server.id, "root_terminal.revoked", x.id);
        await audit(user.id, server.id, "server.revoke", server.id);
        return json({ ok: true });
      }
    }
  }
  if (p[0] === "projects") {
    if (p.length === 1 && method === "GET") {
      const projects = await prisma.projects.findMany({
        where: { user_id: user.id },
        orderBy: { created_at: "desc" },
        include: { servers: { select: { name: true } }, environments: true },
      });
      return json({
        projects: projects.map((project) => ({
          id: project.id,
          name: project.name,
          server_id: project.server_id,
          created_at: project.created_at,
          server_name: project.servers.name,
          environments: project.environments.map((env) => ({
            id: env.id,
            name: env.name,
            imageRef: env.image_ref,
            port: env.container_port,
            healthPath: env.health_path,
            volumePath: env.volume_path,
            registryUsername: env.registry_username,
            hasRegistryToken: env.registry_token_ciphertext !== null,
            activeDeploymentId: env.active_deployment_id,
            runtimeStatus: env.runtime_status,
          })),
        })),
      });
    }
    if (p.length === 1 && method === "POST") {
      const b = await body(request);
      const server = await ownedServer(uuid(b.serverId), user.id);
      const project = await prisma.$transaction(async (db) => {
        const created = await db.projects.create({
          data: {
            user_id: user.id,
            server_id: server.id,
            name: str(b.name, "name", 80),
          },
          select: { id: true, name: true },
        });
        await db.environments.createMany({
          data: [
            { project_id: created.id, name: "production" },
            { project_id: created.id, name: "staging" },
          ],
        });
        return created;
      });
      await audit(user.id, server.id, "project.create", project.id);
      return json({ project }, 201);
    }
  }
  if (p[0] === "environments" && p[1]) {
    const env = await ownedEnvironment(uuid(p[1]), user.id);
    if (p.length === 2 && method === "PATCH") {
      const b = await body(request);
      const image = b.imageRef == null ? env.image_ref : imageRef(b.imageRef);
      const port = b.port == null ? env.container_port : Number(b.port);
      const memory = b.memoryMb == null ? env.memory_mb : Number(b.memoryMb);
      const cpu = b.cpuQuota == null ? env.cpu_quota : Number(b.cpuQuota);
      const health =
        b.healthPath == null
          ? env.health_path
          : str(b.healthPath, "health path", 200);
      const volume =
        b.volumePath === undefined
          ? env.volume_path
          : optional(b.volumePath, "volume path", 200);
      const registryUsername =
        b.registryUsername === undefined
          ? env.registry_username
          : optional(b.registryUsername, "registry username", 100);
      const registryToken =
        b.registryToken === undefined
          ? env.registry_token_ciphertext
          : b.registryToken === null
            ? null
            : encrypt(str(b.registryToken, "registry token", 8192));
      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        !Number.isInteger(memory) ||
        memory < 32 ||
        memory > 32768 ||
        !Number.isInteger(cpu) ||
        cpu < 10000 ||
        cpu > 800000 ||
        !/^\/[a-zA-Z0-9/_-]*$/.test(health) ||
        (volume &&
          (!/^\/[a-zA-Z0-9/_-]+$/.test(volume) ||
            ["/", "/proc", "/sys", "/dev", "/run", "/var/run"].some(
              (x) => volume === x || volume.startsWith(x + "/"),
            ))) ||
        (registryToken && (!registryUsername || !image?.startsWith("ghcr.io/")))
      )
        throw new HttpError(400, "Invalid deployment settings");
      await prisma.environments.update({
        where: { id: env.id },
        data: {
          image_ref: image,
          container_port: port,
          memory_mb: memory,
          cpu_quota: cpu,
          health_path: health,
          volume_path: volume,
          registry_username: registryUsername,
          registry_token_ciphertext: registryToken,
        },
      });
      await audit(user.id, env.server_id, "environment.update", env.id);
      return json({ ok: true });
    }
    if (p[2] === "variables") {
      if (method === "GET") {
        const variables = await prisma.environment_variables.findMany({
          where: { environment_id: env.id },
          orderBy: { name: "asc" },
          select: { name: true, created_at: true },
        });
        return json({ variables });
      }
      if (method === "POST") {
        const b = await body(request);
        const name = str(b.name, "variable name", 128);
        if (typeof b.value !== "string" || b.value.length > 8192)
          throw new HttpError(400, "Invalid variable value");
        const value = b.value;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          throw new HttpError(400, "Invalid variable name");
        const ciphertext = encrypt(value);
        await prisma.environment_variables.upsert({
          where: { environment_id_name: { environment_id: env.id, name } },
          create: { environment_id: env.id, name, ciphertext },
          update: { ciphertext },
        });
        await audit(
          user.id,
          env.server_id,
          "variable.upsert",
          `${env.id}:${name}`,
        );
        return json({ ok: true });
      }
      if (method === "DELETE" && p[3]) {
        await prisma.environment_variables.deleteMany({
          where: { environment_id: env.id, name: p[3] },
        });
        await audit(
          user.id,
          env.server_id,
          "variable.delete",
          `${env.id}:${p[3]}`,
        );
        return json({ ok: true });
      }
    }
    if (p[2] === "domains") {
      if (method === "GET") {
        const domains = await prisma.domains.findMany({
          where: { environment_id: env.id },
          orderBy: { hostname: "asc" },
          select: { id: true, hostname: true, status: true },
        });
        return json({ domains });
      }
      if (method === "POST") {
        const b = await body(request);
        const host = hostname(b.hostname);
        const domain = await prisma.domains.create({
          data: { environment_id: env.id, hostname: host },
          select: { id: true, hostname: true, status: true },
        });
        await audit(user.id, env.server_id, "domain.add", domain.id);
        return json({ domain }, 201);
      }
      if (method === "DELETE" && p[3]) {
        await prisma.domains.deleteMany({
          where: { id: uuid(p[3]), environment_id: env.id },
        });
        await audit(user.id, env.server_id, "domain.delete", p[3]);
        return json({ ok: true });
      }
    }
    if (p[2] === "deploy" && method === "POST") {
      const b = await body(request);
      const ref = b.imageRef ? imageRef(b.imageRef) : env.image_ref;
      if (!ref) throw new HttpError(400, "Configure an image first");
      await requireDeploymentRuntime(env.server_id, env.id);
      const result = await prisma.$transaction(async (db) => {
        const d = await db.deployments.create({
          data: { environment_id: env.id, image_ref: ref },
          select: { id: true, status: true },
        });
        await db.deployment_jobs.create({
          data: {
            server_id: env.server_id,
            environment_id: env.id,
            deployment_id: d.id,
            kind: "deploy",
            payload: { imageRef: ref },
          },
        });
        return d;
      });
      await audit(user.id, env.server_id, "deployment.create", result.id);
      return json({ deployment: result }, 201);
    }
    if (
      (p[2] === "stop" || p[2] === "restart" || p[2] === "logs") &&
      method === "POST"
    ) {
      if (!env.active_deployment_id)
        throw new HttpError(409, "No active deployment");
      await requireDeploymentRuntime(env.server_id, env.id, false);
      if (p[2] === "logs")
        await prisma.deployment_jobs.deleteMany({
          where: {
            kind: "logs",
            finished_at: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        });
      const job = await prisma.deployment_jobs.create({
        data: { server_id: env.server_id, environment_id: env.id, kind: p[2] },
        select: { id: true, status: true },
      });
      await audit(user.id, env.server_id, `environment.${p[2]}`, env.id);
      return json({ job }, 201);
    }
  }
  if (
    p[0] === "deployments" &&
    p[1] &&
    p[2] === "redeploy" &&
    method === "POST"
  ) {
    const oldDeployment = await prisma.deployments.findFirst({
      where: {
        id: uuid(p[1]),
        environments_deployments_environment_idToenvironments: {
          projects: { user_id: user.id },
        },
      },
      select: {
        image_digest: true,
        environment_id: true,
        environments_deployments_environment_idToenvironments: {
          select: { projects: { select: { server_id: true } } },
        },
      },
    });
    if (!oldDeployment) throw new HttpError(404, "Deployment not found");
    if (!oldDeployment.image_digest?.includes("@sha256:"))
      throw new HttpError(409, "This deployment has no immutable image digest");
    const old = {
      image_digest: oldDeployment.image_digest,
      environment_id: oldDeployment.environment_id,
      server_id:
        oldDeployment.environments_deployments_environment_idToenvironments
          .projects.server_id,
    };
    await requireDeploymentRuntime(old.server_id, old.environment_id);
    const created = await prisma.$transaction(async (db) => {
      const d = await db.deployments.create({
        data: {
          environment_id: old.environment_id,
          image_ref: old.image_digest,
        },
        select: { id: true },
      });
      await db.deployment_jobs.create({
        data: {
          server_id: old.server_id,
          environment_id: old.environment_id,
          deployment_id: d.id,
          kind: "deploy",
          payload: { imageRef: old.image_digest },
        },
      });
      return d;
    });
    await audit(user.id, old.server_id, "deployment.redeploy", created.id);
    return json({ deployment: created }, 201);
  }
  if (p[0] === "deployments" && method === "GET") {
    if (p[1]) {
      const deployment = await prisma.deployments.findFirst({
        where: {
          id: uuid(p[1]),
          environments_deployments_environment_idToenvironments: {
            projects: { user_id: user.id },
          },
        },
        include: {
          environments_deployments_environment_idToenvironments: {
            select: { name: true, projects: { select: { name: true } } },
          },
          deployment_jobs: {
            where: { kind: "deploy" },
            select: { error: true, result: true },
            take: 1,
          },
        },
      });
      if (!deployment) throw new HttpError(404, "Deployment not found");
      const {
        environments_deployments_environment_idToenvironments: environment,
        deployment_jobs: jobs,
        ...fields
      } = deployment;
      return json({
        deployment: {
          ...fields,
          project: environment.projects.name,
          environment: environment.name,
          error: jobs[0]?.error ?? null,
          result: jobs[0]?.result ?? null,
        },
      });
    }
    const deployments = await prisma.deployments.findMany({
      where: {
        environments_deployments_environment_idToenvironments: {
          projects: { user_id: user.id },
        },
      },
      orderBy: { created_at: "desc" },
      take: 100,
      select: {
        id: true,
        image_ref: true,
        image_digest: true,
        status: true,
        message: true,
        created_at: true,
        finished_at: true,
        environments_deployments_environment_idToenvironments: {
          select: { name: true, projects: { select: { name: true } } },
        },
      },
    });
    return json({
      deployments: deployments.map((d) => ({
        id: d.id,
        image_ref: d.image_ref,
        image_digest: d.image_digest,
        status: d.status,
        message: d.message,
        created_at: d.created_at,
        finished_at: d.finished_at,
        project:
          d.environments_deployments_environment_idToenvironments.projects.name,
        environment:
          d.environments_deployments_environment_idToenvironments.name,
      })),
    });
  }
  if (p[0] === "jobs" && p[1] && method === "GET") {
    const job = await prisma.deployment_jobs.findFirst({
      where: {
        id: uuid(p[1]),
        environments: { projects: { user_id: user.id } },
      },
      select: {
        id: true,
        kind: true,
        status: true,
        result: true,
        error: true,
        created_at: true,
        finished_at: true,
      },
    });
    if (!job) throw new HttpError(404, "Job not found");
    return json({ job });
  }
  throw new HttpError(404, "Endpoint not found");
}

async function route(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await context.params;
    return await handle(request, path, request.method);
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    const code = (error as { code?: string }).code;
    if (code === "23505" || code === "P2002")
      return json(
        {
          error: "Resource already exists or another operation is in progress",
        },
        409,
      );
    if (code === "23503" || code === "P2003")
      return json({ error: "Related resource not found" }, 400);
    console.error(
      "API failure",
      error instanceof Error ? error.message : "unknown",
    );
    return json({ error: "Internal error" }, 500);
  }
}
export { route as GET, route as POST, route as PATCH, route as DELETE };
