import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { pool, transaction } from "@/lib/db";
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
  await pool.query(
    "INSERT INTO audit_logs(user_id,server_id,action,resource_id) VALUES($1,$2,$3,$4)",
    [userId, serverId, action, resourceId],
  );
}
async function ownedServer(id: string, userId: string) {
  const r = await pool.query(
    "SELECT * FROM servers WHERE id=$1 AND user_id=$2",
    [id, userId],
  );
  if (!r.rowCount) throw new HttpError(404, "Server not found");
  return r.rows[0];
}
async function ownedEnvironment(id: string, userId: string) {
  const r = await pool.query(
    `SELECT e.*,p.server_id,p.name AS project_name FROM environments e JOIN projects p ON p.id=e.project_id WHERE e.id=$1 AND p.user_id=$2`,
    [id, userId],
  );
  if (!r.rowCount) throw new HttpError(404, "Environment not found");
  return r.rows[0];
}
async function rateLimit(key: string, maximum: number) {
  const hash = sha256(key);
  const r = await pool.query(
    "SELECT count(*)::int AS count FROM login_attempts WHERE key_hash=$1 AND occurred_at>now()-interval '15 minutes'",
    [hash],
  );
  if (r.rows[0].count >= maximum) throw new HttpError(429, "Too many attempts");
  await pool.query("INSERT INTO login_attempts(key_hash) VALUES($1)", [hash]);
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
  const expired = await pool.query(
    "UPDATE terminal_sessions SET status='closed',closed_at=now() WHERE status<>'closed' AND expires_at<=now() RETURNING id,user_id,server_id",
  );
  for (const x of expired.rows)
    await audit(x.user_id, x.server_id, "root_terminal.expire", x.id);
  await pool.query(
    "DELETE FROM terminal_sessions WHERE status='closed' AND closed_at<now()-interval '1 day'",
  );
}

async function handle(request: NextRequest, path: string[], method: string) {
  const p = path;
  const agentRoute = p[0] === "agent";
  if (method !== "GET" && !agentRoute && !(await validOrigin(request)))
    throw new HttpError(403, "Invalid request origin");

  if (p[0] === "auth") {
    if (p[1] === "me" && method === "GET")
      return json({ user: await currentUser() });
    if (p[1] === "bootstrap" && method === "POST") {
      const b = await body(request);
      const email = str(b.email, "email", 254).toLowerCase();
      const password = str(b.password, "password", 256);
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || password.length < 12)
        throw new HttpError(
          400,
          "Use a valid email and a password of at least 12 characters",
        );
      const bootstrapToken = str(b.bootstrapToken, "bootstrap token");
      await rateLimit(`bootstrap:${sha256(bootstrapToken)}`, 5);
      if (
        !process.env.BOOTSTRAP_TOKEN ||
        !safeEqual(bootstrapToken, process.env.BOOTSTRAP_TOKEN)
      )
        throw new HttpError(403, "Invalid bootstrap token");
      const passwordHash = await hashPassword(password);
      const user = await transaction(async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(821614)");
        const count = await c.query("SELECT 1 FROM users LIMIT 1");
        if (count.rowCount) throw new HttpError(409, "Owner already exists");
        return (
          await c.query(
            "INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id,email",
            [email, passwordHash],
          )
        ).rows[0];
      });
      await audit(user.id, null, "owner.bootstrap", user.id);
      return json({ user }, 201);
    }
    if (p[1] === "login" && method === "POST") {
      const b = await body(request);
      const email = str(b.email, "email", 254).toLowerCase();
      const password = str(b.password, "password", 256);
      await rateLimit(`login:${email}`, 10);
      const r = await pool.query(
        "SELECT id,email,password_hash FROM users WHERE email=$1",
        [email],
      );
      if (
        !r.rowCount ||
        !(await verifyPassword(password, r.rows[0].password_hash))
      )
        throw new HttpError(401, "Invalid credentials");
      const token = secret();
      await pool.query(
        "INSERT INTO sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '7 days')",
        [r.rows[0].id, sha256(token)],
      );
      (await cookies()).set("deplo_session", token, cookieSettings());
      return json({ user: { id: r.rows[0].id, email } });
    }
    if (p[1] === "logout" && method === "POST") {
      const token = (await cookies()).get("deplo_session")?.value;
      if (token)
        await pool.query("DELETE FROM sessions WHERE token_hash=$1", [
          sha256(token),
        ]);
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
      await pool.query(
        `UPDATE servers SET status='online',last_seen_at=now(),agent_version=$2,docker_available=$3,caddy_available=$4,metrics=$5,architecture=$6,terminal_available=$7 WHERE id=$1`,
        [
          agent.server_id,
          str(b.version, "version", 64),
          b.dockerAvailable === true,
          b.caddyAvailable === true,
          JSON.stringify(validated),
          b.architecture ? str(b.architecture, "architecture", 32) : null,
          b.terminalAvailable === true,
        ],
      );
      if (b.terminalAvailable !== true) {
        const closed = await pool.query(
          "UPDATE terminal_sessions SET status='closed',closed_at=now() WHERE server_id=$1 AND status<>'closed' RETURNING id,user_id",
          [agent.server_id],
        );
        for (const x of closed.rows)
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
      await expireTerminals();
      const result = await transaction(async (c) => {
        const sessions = await c.query(
          "SELECT id,expires_at,cols,rows FROM terminal_sessions WHERE server_id=$1 AND status IN ('pending','active') ORDER BY created_at LIMIT 1 FOR UPDATE",
          [agent.server_id],
        );
        if (!sessions.rowCount) return null;
        const session = sessions.rows[0];
        await c.query(
          "UPDATE terminal_sessions SET status='active' WHERE id=$1",
          [session.id],
        );
        const inputs = await c.query(
          "DELETE FROM terminal_inputs WHERE id IN (SELECT id FROM terminal_inputs WHERE session_id=$1 ORDER BY id LIMIT 32 FOR UPDATE SKIP LOCKED) RETURNING id,data",
          [session.id],
        );
        return {
          id: session.id,
          expiresAt: session.expires_at,
          cols: session.cols,
          rows: session.rows,
          inputs: inputs.rows
            .sort((a, b) => Number(a.id) - Number(b.id))
            .map((x) => decrypt(x.data)),
        };
      });
      return json({ session: result });
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
      await pool.query(
        "INSERT INTO agent_credentials(server_id,token_hash,pending) VALUES($1,$2,true)",
        [agent.server_id, sha256(credential)],
      );
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
      const env = await pool.query(
        `SELECT e.*,p.name AS project_name FROM environments e JOIN projects p ON p.id=e.project_id WHERE e.id=$1`,
        [job.environment_id],
      );
      const vars = await pool.query(
        "SELECT name,ciphertext FROM environment_variables WHERE environment_id=$1",
        [job.environment_id],
      );
      const domains = await pool.query(
        "SELECT hostname FROM domains WHERE environment_id=$1",
        [job.environment_id],
      );
      const previous = await pool.query(
        "SELECT id FROM deployments WHERE id=$1",
        [env.rows[0].active_deployment_id],
      );
      return json({
        job: {
          id: job.id,
          kind: job.kind,
          deploymentId: job.deployment_id,
          lease,
          environmentId: job.environment_id,
          imageRef: job.payload.imageRef ?? env.rows[0].image_ref,
          port: env.rows[0].container_port,
          memoryMb: env.rows[0].memory_mb,
          cpuQuota: env.rows[0].cpu_quota,
          healthPath: env.rows[0].health_path,
          volumePath: env.rows[0].volume_path,
          registryUsername: env.rows[0].registry_username,
          registryToken: env.rows[0].registry_token_ciphertext
            ? decrypt(env.rows[0].registry_token_ciphertext)
            : null,
          previousDeploymentId: previous.rows[0]?.id ?? null,
          variables: Object.fromEntries(
            vars.rows.map((v) => [v.name, decrypt(v.ciphertext)]),
          ),
          domains: domains.rows.map((d) => d.hostname),
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
      pool.query("SELECT count(*)::int AS n FROM servers WHERE user_id=$1", [
        user.id,
      ]),
      pool.query(
        `SELECT count(*)::int AS n FROM environments e JOIN projects p ON p.id=e.project_id WHERE p.user_id=$1 AND e.runtime_status='running'`,
        [user.id],
      ),
      pool.query(
        `SELECT d.id,d.status,d.image_ref,d.created_at,p.name AS project,e.name AS environment FROM deployments d JOIN environments e ON e.id=d.environment_id JOIN projects p ON p.id=e.project_id WHERE p.user_id=$1 ORDER BY d.created_at DESC LIMIT 8`,
        [user.id],
      ),
    ]);
    return json({
      servers: servers.rows[0].n,
      applications: apps.rows[0].n,
      recentDeployments: deployments.rows,
    });
  }
  if (p[0] === "servers") {
    if (p.length === 1 && method === "GET") {
      const r = await pool.query(
        `SELECT id,name,ip,description,status,agent_version,architecture,docker_available,caddy_available,terminal_available,metrics,last_seen_at,created_at,
        (last_seen_at>now()-interval '3 minutes' AND status='online') AS connected FROM servers WHERE user_id=$1 ORDER BY created_at DESC`,
        [user.id],
      );
      return json({ servers: r.rows });
    }
    if (p.length === 1 && method === "POST") {
      const b = await body(request);
      const name = str(b.name, "name", 80);
      const r = await pool.query(
        "INSERT INTO servers(user_id,name,ip,description) VALUES($1,$2,$3,$4) RETURNING id,name,status",
        [
          user.id,
          name,
          optional(b.ip, "IP address", 64),
          optional(b.description, "description", 500),
        ],
      );
      await audit(user.id, r.rows[0].id, "server.create", r.rows[0].id);
      return json({ server: r.rows[0] }, 201);
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
          const owner = await pool.query(
            "SELECT password_hash FROM users WHERE id=$1",
            [user.id],
          );
          if (
            !owner.rowCount ||
            !(await verifyPassword(password, owner.rows[0].password_hash))
          )
            throw new HttpError(401, "Incorrect password");
          const r = await pool.query(
            "INSERT INTO terminal_sessions(server_id,user_id,expires_at) VALUES($1,$2,now()+interval '10 minutes') RETURNING id,expires_at",
            [server.id, user.id],
          );
          await audit(user.id, server.id, "root_terminal.open", r.rows[0].id);
          return json(
            { sessionId: r.rows[0].id, expiresAt: r.rows[0].expires_at },
            201,
          );
        }
        if (p[3]) {
          const sessionId = uuid(p[3]);
          const r = await pool.query(
            "SELECT id,status,expires_at FROM terminal_sessions WHERE id=$1 AND server_id=$2 AND user_id=$3",
            [sessionId, server.id, user.id],
          );
          if (!r.rowCount)
            throw new HttpError(404, "Terminal session not found");
          const session = r.rows[0];
          if (p.length === 4 && method === "GET") {
            const after = Number(
              new URL(request.url).searchParams.get("after") ?? "0",
            );
            if (!Number.isSafeInteger(after) || after < 0)
              throw new HttpError(400, "Invalid output cursor");
            const output = await pool.query(
              "SELECT id,data FROM terminal_outputs WHERE session_id=$1 AND id>$2 ORDER BY id LIMIT 50",
              [sessionId, after],
            );
            return json({
              status: session.status,
              expiresAt: session.expires_at,
              output: output.rows.map((x) => ({
                id: x.id,
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
            const resized = await pool.query(
              "UPDATE terminal_sessions SET cols=$2,rows=$3 WHERE id=$1 AND status IN ('pending','active') AND expires_at>now() RETURNING id",
              [sessionId, cols, rows],
            );
            if (!resized.rowCount)
              throw new HttpError(409, "Terminal session closed");
            return json({ ok: true });
          }
          if (p[4] === "close" && method === "POST") {
            const closed = await transaction(async (c) => {
              const changed = await c.query(
                "UPDATE terminal_sessions SET status='closed',closed_at=now() WHERE id=$1 AND status<>'closed' RETURNING id",
                [sessionId],
              );
              await c.query("DELETE FROM terminal_inputs WHERE session_id=$1", [
                sessionId,
              ]);
              return changed.rowCount;
            });
            if (closed)
              await audit(user.id, server.id, "root_terminal.close", sessionId);
            return json({ ok: true });
          }
        }
      }
      if (p[2] === "pair" && method === "POST") {
        const token = secret();
        await pool.query(
          "INSERT INTO pairing_tokens(server_id,token_hash,expires_at) VALUES($1,$2,now()+interval '10 minutes')",
          [server.id, sha256(token)],
        );
        await audit(user.id, server.id, "server.pair_token", server.id);
        return json({ token, expiresInSeconds: 600 });
      }
      if (p[2] === "revoke" && method === "POST") {
        const closed = await transaction(async (c) => {
          await c.query(
            "UPDATE agent_credentials SET revoked_at=now() WHERE server_id=$1",
            [server.id],
          );
          await c.query("UPDATE servers SET status='revoked' WHERE id=$1", [
            server.id,
          ]);
          return (
            await c.query(
              "UPDATE terminal_sessions SET status='closed',closed_at=now() WHERE server_id=$1 AND status<>'closed' RETURNING id",
              [server.id],
            )
          ).rows;
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
      const r = await pool.query(
        `SELECT p.id,p.name,p.server_id,p.created_at,s.name AS server_name,
        coalesce(json_agg(json_build_object('id',e.id,'name',e.name,'imageRef',e.image_ref,'port',e.container_port,'healthPath',e.health_path,'volumePath',e.volume_path,'registryUsername',e.registry_username,'hasRegistryToken',e.registry_token_ciphertext IS NOT NULL,'activeDeploymentId',e.active_deployment_id,'runtimeStatus',e.runtime_status)) FILTER (WHERE e.id IS NOT NULL),'[]') AS environments
        FROM projects p JOIN servers s ON s.id=p.server_id LEFT JOIN environments e ON e.project_id=p.id WHERE p.user_id=$1 GROUP BY p.id,s.name ORDER BY p.created_at DESC`,
        [user.id],
      );
      return json({ projects: r.rows });
    }
    if (p.length === 1 && method === "POST") {
      const b = await body(request);
      const server = await ownedServer(uuid(b.serverId), user.id);
      const project = await transaction(async (c) => {
        const r = await c.query(
          "INSERT INTO projects(user_id,server_id,name) VALUES($1,$2,$3) RETURNING id,name",
          [user.id, server.id, str(b.name, "name", 80)],
        );
        for (const name of ["production", "staging"])
          await c.query(
            "INSERT INTO environments(project_id,name) VALUES($1,$2)",
            [r.rows[0].id, name],
          );
        return r.rows[0];
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
      await pool.query(
        "UPDATE environments SET image_ref=$2,container_port=$3,memory_mb=$4,cpu_quota=$5,health_path=$6,volume_path=$7,registry_username=$8,registry_token_ciphertext=$9 WHERE id=$1",
        [
          env.id,
          image,
          port,
          memory,
          cpu,
          health,
          volume,
          registryUsername,
          registryToken,
        ],
      );
      await audit(user.id, env.server_id, "environment.update", env.id);
      return json({ ok: true });
    }
    if (p[2] === "variables") {
      if (method === "GET") {
        const r = await pool.query(
          "SELECT name,created_at FROM environment_variables WHERE environment_id=$1 ORDER BY name",
          [env.id],
        );
        return json({ variables: r.rows });
      }
      if (method === "POST") {
        const b = await body(request);
        const name = str(b.name, "variable name", 128);
        if (typeof b.value !== "string" || b.value.length > 8192)
          throw new HttpError(400, "Invalid variable value");
        const value = b.value;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          throw new HttpError(400, "Invalid variable name");
        await pool.query(
          "INSERT INTO environment_variables(environment_id,name,ciphertext) VALUES($1,$2,$3) ON CONFLICT(environment_id,name) DO UPDATE SET ciphertext=excluded.ciphertext",
          [env.id, name, encrypt(value)],
        );
        await audit(
          user.id,
          env.server_id,
          "variable.upsert",
          `${env.id}:${name}`,
        );
        return json({ ok: true });
      }
      if (method === "DELETE" && p[3]) {
        await pool.query(
          "DELETE FROM environment_variables WHERE environment_id=$1 AND name=$2",
          [env.id, p[3]],
        );
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
        const r = await pool.query(
          "SELECT id,hostname,status FROM domains WHERE environment_id=$1 ORDER BY hostname",
          [env.id],
        );
        return json({ domains: r.rows });
      }
      if (method === "POST") {
        const b = await body(request);
        const host = hostname(b.hostname);
        const r = await pool.query(
          "INSERT INTO domains(environment_id,hostname) VALUES($1,$2) RETURNING id,hostname,status",
          [env.id, host],
        );
        await audit(user.id, env.server_id, "domain.add", r.rows[0].id);
        return json({ domain: r.rows[0] }, 201);
      }
      if (method === "DELETE" && p[3]) {
        await pool.query(
          "DELETE FROM domains WHERE id=$1 AND environment_id=$2",
          [uuid(p[3]), env.id],
        );
        await audit(user.id, env.server_id, "domain.delete", p[3]);
        return json({ ok: true });
      }
    }
    if (p[2] === "deploy" && method === "POST") {
      const b = await body(request);
      const ref = b.imageRef ? imageRef(b.imageRef) : env.image_ref;
      if (!ref) throw new HttpError(400, "Configure an image first");
      const result = await transaction(async (c) => {
        const d = (
          await c.query(
            "INSERT INTO deployments(environment_id,image_ref) VALUES($1,$2) RETURNING id,status",
            [env.id, ref],
          )
        ).rows[0];
        await c.query(
          "INSERT INTO deployment_jobs(server_id,environment_id,deployment_id,kind,payload) VALUES($1,$2,$3,'deploy',$4)",
          [env.server_id, env.id, d.id, JSON.stringify({ imageRef: ref })],
        );
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
      if (p[2] === "logs")
        await pool.query(
          "DELETE FROM deployment_jobs WHERE kind='logs' AND finished_at<now()-interval '7 days'",
        );
      const r = await pool.query(
        "INSERT INTO deployment_jobs(server_id,environment_id,kind) VALUES($1,$2,$3) RETURNING id,status",
        [env.server_id, env.id, p[2]],
      );
      await audit(user.id, env.server_id, `environment.${p[2]}`, env.id);
      return json({ job: r.rows[0] }, 201);
    }
  }
  if (
    p[0] === "deployments" &&
    p[1] &&
    p[2] === "redeploy" &&
    method === "POST"
  ) {
    const r = await pool.query(
      `SELECT d.image_digest,e.id AS environment_id,p.server_id FROM deployments d JOIN environments e ON e.id=d.environment_id JOIN projects p ON p.id=e.project_id WHERE d.id=$1 AND p.user_id=$2`,
      [uuid(p[1]), user.id],
    );
    if (!r.rowCount) throw new HttpError(404, "Deployment not found");
    if (!r.rows[0].image_digest?.includes("@sha256:"))
      throw new HttpError(409, "This deployment has no immutable image digest");
    const old = r.rows[0];
    const created = await transaction(async (c) => {
      const d = (
        await c.query(
          "INSERT INTO deployments(environment_id,image_ref) VALUES($1,$2) RETURNING id",
          [old.environment_id, old.image_digest],
        )
      ).rows[0];
      await c.query(
        "INSERT INTO deployment_jobs(server_id,environment_id,deployment_id,kind,payload) VALUES($1,$2,$3,'deploy',$4)",
        [
          old.server_id,
          old.environment_id,
          d.id,
          JSON.stringify({ imageRef: old.image_digest }),
        ],
      );
      return d;
    });
    await audit(user.id, old.server_id, "deployment.redeploy", created.id);
    return json({ deployment: created }, 201);
  }
  if (p[0] === "deployments" && method === "GET") {
    if (p[1]) {
      const r = await pool.query(
        `SELECT d.*,p.name AS project,e.name AS environment,j.error,j.result FROM deployments d JOIN environments e ON e.id=d.environment_id JOIN projects p ON p.id=e.project_id LEFT JOIN deployment_jobs j ON j.deployment_id=d.id WHERE d.id=$1 AND p.user_id=$2`,
        [uuid(p[1]), user.id],
      );
      if (!r.rowCount) throw new HttpError(404, "Deployment not found");
      return json({ deployment: r.rows[0] });
    }
    const r = await pool.query(
      `SELECT d.id,d.image_ref,d.image_digest,d.status,d.message,d.created_at,d.finished_at,p.name AS project,e.name AS environment FROM deployments d JOIN environments e ON e.id=d.environment_id JOIN projects p ON p.id=e.project_id WHERE p.user_id=$1 ORDER BY d.created_at DESC LIMIT 100`,
      [user.id],
    );
    return json({ deployments: r.rows });
  }
  if (p[0] === "jobs" && p[1] && method === "GET") {
    const r = await pool.query(
      `SELECT j.id,j.kind,j.status,j.result,j.error,j.created_at,j.finished_at FROM deployment_jobs j JOIN environments e ON e.id=j.environment_id JOIN projects p ON p.id=e.project_id WHERE j.id=$1 AND p.user_id=$2`,
      [uuid(p[1]), user.id],
    );
    if (!r.rowCount) throw new HttpError(404, "Job not found");
    return json({ job: r.rows[0] });
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
    if (code === "23505")
      return json(
        {
          error: "Resource already exists or another operation is in progress",
        },
        409,
      );
    if (code === "23503")
      return json({ error: "Related resource not found" }, 400);
    console.error(
      "API failure",
      error instanceof Error ? error.message : "unknown",
    );
    return json({ error: "Internal error" }, 500);
  }
}
export { route as GET, route as POST, route as PATCH, route as DELETE };
