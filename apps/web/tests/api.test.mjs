import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import pg from "pg";

const databaseURL = process.env.DEPLO_TEST_DATABASE_URL;
if (!databaseURL) {
  test(
    "API integration requires DEPLO_TEST_DATABASE_URL",
    { skip: true },
    () => {},
  );
} else {
  const parsed = new URL(databaseURL);
  assert.match(
    parsed.pathname,
    /\/deplo_test$/,
    "Refusing to reset a database without the deplo_test name",
  );
  const root = new URL("../../..", import.meta.url).pathname;
  const port = 3457;
  const publicURL = `http://localhost:${port}`;
  const key = randomBytes(32).toString("base64");
  const registrationCode = randomBytes(24).toString("hex");
  const env = {
    ...process.env,
    DATABASE_URL: databaseURL,
    DIRECT_URL: databaseURL,
    PUBLIC_URL: publicURL,
    ENCRYPTION_KEY: key,
    REGISTRATION_CODE: registrationCode,
  };
  test("control plane integration", async (t) => {
    const client = new pg.Client({ connectionString: databaseURL });
    await client.connect();
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await client.end();
    const migrated = spawnSync(process.execPath, ["scripts/migrate.mjs"], {
      cwd: root,
      env,
      encoding: "utf8",
    });
    assert.equal(migrated.status, 0, migrated.stderr);
    const server = spawn(
      process.execPath,
      [root + "/node_modules/next/dist/bin/next", "start"],
      {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...env, PORT: String(port) },
        stdio: "pipe",
      },
    );
    t.after(() => server.kill("SIGTERM"));
    let output = "";
    server.stderr.on("data", (x) => (output += x));
    server.stdout.on("data", (x) => (output += x));
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(publicURL + "/api/auth/me");
        if (r.ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    const call = async (path, method = "GET", data, credential, cookie) => {
      const response = await fetch(publicURL + "/api/" + path, {
        method,
        headers: {
          Origin: publicURL,
          "Content-Type": "application/json",
          ...(credential
            ? { Authorization: `Bearer ${credential}` }
            : { cookie: cookie ?? "" }),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      return {
        status: response.status,
        data: await response.json(),
        cookie: response.headers.get("set-cookie"),
      };
    };
    let r = await call("servers");
    assert.equal(r.status, 401, output);
    r = await call("auth/register", "POST", {
      email: "owner@example.com",
      password: "strong-password-1234",
      registrationCode,
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    r = await call("auth/login", "POST", {
      email: "owner@example.com",
      password: "strong-password-1234",
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const cookie = r.cookie.split(";")[0];
    assert.match(r.cookie, /HttpOnly/);
    assert.match(r.cookie, /SameSite=strict/i);
    const missingOrigin = await fetch(publicURL + "/api/servers", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "blocked" }),
    });
    assert.equal(missingOrigin.status, 403);
    r = await call("servers", "POST", { name: "Test VPS" }, null, cookie);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const serverId = r.data.server.id;
    r = await call(`servers/${serverId}/pair`, "POST", {}, null, cookie);
    assert.equal(r.status, 200);
    const expiredToken = r.data.token;
    const direct = new pg.Client({ connectionString: databaseURL });
    await direct.connect();
    t.after(() => direct.end());
    await direct.query(
      "UPDATE pairing_tokens SET expires_at=now()-interval '1 second' WHERE server_id=$1",
      [serverId],
    );
    r = await call("agent/pair", "POST", { token: expiredToken });
    assert.equal(r.status, 401, "Expired pairing token must fail");
    r = await call(`servers/${serverId}/pair`, "POST", {}, null, cookie);
    assert.equal(r.status, 200);
    const pairToken = r.data.token;
    r = await call("agent/pair", "POST", { token: pairToken });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const agentCredential = r.data.credential;
    r = await call("agent/pair", "POST", { token: pairToken });
    assert.equal(r.status, 401, "Pairing token must be single use");
    r = await call(
      "agent/heartbeat",
      "POST",
      {
        version: "test",
        architecture: "amd64",
        dockerAvailable: true,
        caddyAvailable: false,
        metrics: {
          cpuPercent: 1,
          memoryUsed: 100,
          memoryTotal: 200,
          diskUsed: 30,
          diskTotal: 100,
          containers: [
            {
              deploymentId: "11111111-1111-4111-8111-111111111111",
              status: "running",
              cpuPercent: 2,
              memoryUsed: 100,
              memoryLimit: 200,
            },
          ],
        },
      },
      agentCredential,
    );
    assert.equal(r.status, 200);
    r = await call("servers", "GET", undefined, null, cookie);
    assert.equal(r.data.servers[0].metrics.containers.length, 1);
    r = await call(
      `servers/${serverId}/terminal`,
      "POST",
      { password: "strong-password-1234" },
      null,
      cookie,
    );
    assert.equal(r.status, 409, "Root terminal must be disabled by default");
    const heartbeat = {
      version: "test",
      architecture: "amd64",
      dockerAvailable: false,
      caddyAvailable: false,
      terminalAvailable: true,
      metrics: {
        cpuPercent: 0,
        memoryUsed: 0,
        memoryTotal: 0,
        diskUsed: 0,
        diskTotal: 0,
      },
    };
    r = await call("agent/heartbeat", "POST", heartbeat, agentCredential);
    assert.equal(r.status, 200);
    r = await call("servers", "GET", undefined, null, cookie);
    assert.equal(r.data.servers[0].docker_available, false);
    assert.equal(r.data.servers[0].terminal_available, true);
    r = await call(
      `servers/${serverId}/terminal`,
      "POST",
      { password: "wrong-password" },
      null,
      cookie,
    );
    assert.equal(r.status, 401);
    r = await call(
      `servers/${serverId}/terminal`,
      "POST",
      { password: "strong-password-1234" },
      null,
      cookie,
    );
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const terminalId = r.data.sessionId;
    r = await call(
      `servers/${serverId}/terminal`,
      "POST",
      { password: "strong-password-1234" },
      null,
      cookie,
    );
    assert.equal(r.status, 409, "Only one open shell per server");
    r = await call("agent/terminal/poll", "POST", {}, agentCredential);
    assert.equal(r.data.session.id, terminalId);
    r = await call(
      `servers/${serverId}/terminal/${terminalId}/resize`,
      "POST",
      { cols: 112, rows: 37 },
      null,
      cookie,
    );
    assert.equal(r.status, 200);
    r = await call(
      `servers/${serverId}/terminal/${terminalId}/input`,
      "POST",
      { data: Buffer.from("echo deplo\n").toString("base64") },
      null,
      cookie,
    );
    assert.equal(r.status, 200);
    const storedInput = await direct.query(
      "SELECT data FROM terminal_inputs WHERE session_id=$1",
      [terminalId],
    );
    assert.notEqual(
      storedInput.rows[0].data,
      Buffer.from("echo deplo\n").toString("base64"),
    );
    r = await call("agent/terminal/poll", "POST", {}, agentCredential);
    assert.deepEqual(r.data.session.inputs, [
      Buffer.from("echo deplo\n").toString("base64"),
    ]);
    assert.equal(r.data.session.cols, 112);
    assert.equal(r.data.session.rows, 37);
    r = await call(
      "agent/terminal/output",
      "POST",
      {
        sessionId: terminalId,
        data: Buffer.from("deplo\r\n").toString("base64"),
      },
      agentCredential,
    );
    assert.equal(r.status, 200);
    const storedOutput = await direct.query(
      "SELECT data FROM terminal_outputs WHERE session_id=$1",
      [terminalId],
    );
    assert.notEqual(
      storedOutput.rows[0].data,
      Buffer.from("deplo\r\n").toString("base64"),
    );
    r = await call(
      `servers/${serverId}/terminal/${terminalId}`,
      "GET",
      undefined,
      null,
      cookie,
    );
    assert.equal(
      Buffer.from(r.data.output[0].data, "base64").toString(),
      "deplo\r\n",
    );
    const waitingForOutput = call(
      `servers/${serverId}/terminal/${terminalId}?after=${r.data.output[0].id}&wait=1`,
      "GET",
      undefined,
      null,
      cookie,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    r = await call(
      "agent/terminal/poll",
      "POST",
      {
        sessionId: terminalId,
        data: Buffer.from("combined output\r\n").toString("base64"),
      },
      agentCredential,
    );
    assert.equal(r.data.session.id, terminalId);
    r = await waitingForOutput;
    assert.equal(r.status, 200);
    assert.equal(
      Buffer.from(r.data.output[0].data, "base64").toString(),
      "combined output\r\n",
    );
    r = await call(
      `servers/${serverId}/terminal/${terminalId}/close`,
      "POST",
      {},
      null,
      cookie,
    );
    assert.equal(r.status, 200);
    r = await call("agent/terminal/poll", "POST", {}, agentCredential);
    assert.equal(r.data.session, null);
    r = await call(
      "agent/terminal/output",
      "POST",
      { sessionId: terminalId, data: Buffer.from("late").toString("base64") },
      agentCredential,
    );
    assert.equal(r.status, 409);
    r = await call(
      `servers/${serverId}/terminal/${terminalId}/input`,
      "POST",
      { data: Buffer.from("late").toString("base64") },
      null,
      cookie,
    );
    assert.equal(r.status, 409, "Closed shell must reject input");
    r = await call(
      `servers/${serverId}/terminal`,
      "POST",
      { password: "strong-password-1234" },
      null,
      cookie,
    );
    assert.equal(r.status, 201);
    const expiredTerminalId = r.data.sessionId;
    await direct.query(
      "UPDATE terminal_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
      [expiredTerminalId],
    );
    r = await call("agent/terminal/poll", "POST", {}, agentCredential);
    assert.equal(r.data.session, null);
    r = await call(
      `servers/${serverId}/terminal/${expiredTerminalId}`,
      "GET",
      undefined,
      null,
      cookie,
    );
    assert.equal(r.data.status, "closed");
    r = await call(
      `servers/${serverId}/terminal`,
      "POST",
      { password: "strong-password-1234" },
      null,
      cookie,
    );
    assert.equal(r.status, 201);
    const completedTerminalId = r.data.sessionId;
    r = await call("agent/terminal/poll", "POST", {}, agentCredential);
    assert.equal(r.data.session.id, completedTerminalId);
    r = await call(
      "agent/terminal/poll",
      "POST",
      {
        sessionId: completedTerminalId,
        data: Buffer.from("final output\r\n").toString("base64"),
        closed: true,
      },
      agentCredential,
    );
    assert.equal(r.data.session, null);
    r = await call(
      `servers/${serverId}/terminal/${completedTerminalId}`,
      "GET",
      undefined,
      null,
      cookie,
    );
    assert.equal(r.data.status, "closed");
    assert.equal(
      Buffer.from(r.data.output[0].data, "base64").toString(),
      "final output\r\n",
    );
    r = await call(
      "projects",
      "POST",
      { name: "api-test", serverId },
      null,
      cookie,
    );
    assert.equal(r.status, 201, JSON.stringify(r.data));
    r = await call("projects", "GET", undefined, null, cookie);
    assert.equal(r.data.projects[0].environments.length, 2);
    const envId = r.data.projects[0].environments[0].id;
    r = await call(
      `environments/${envId}`,
      "PATCH",
      {
        imageRef: "ghcr.io/example/private:v1",
        port: 80,
        healthPath: "/",
        volumePath: "/app/data",
        registryUsername: "example",
        registryToken: "registry-secret",
      },
      null,
      cookie,
    );
    assert.equal(r.status, 200, JSON.stringify(r.data));
    r = await call(
      `environments/${envId}/variables`,
      "POST",
      { name: "API_SECRET", value: "never-read-back" },
      null,
      cookie,
    );
    assert.equal(r.status, 200);
    r = await call(
      `environments/${envId}/variables`,
      "GET",
      undefined,
      null,
      cookie,
    );
    assert.equal(JSON.stringify(r.data).includes("never-read-back"), false);
    r = await call(`environments/${envId}/deploy`, "POST", {}, null, cookie);
    assert.equal(r.status, 409, "Docker must be optional until deployment");
    assert.match(r.data.error, /Docker is not ready/);
    r = await call(
      "agent/heartbeat",
      "POST",
      { ...heartbeat, dockerAvailable: true },
      agentCredential,
    );
    assert.equal(r.status, 200);
    r = await call(
      `environments/${envId}/domains`,
      "POST",
      { hostname: "app.example.com" },
      null,
      cookie,
    );
    assert.equal(r.status, 201);
    r = await call(`environments/${envId}/deploy`, "POST", {}, null, cookie);
    assert.equal(
      r.status,
      409,
      "Caddy must be optional until a domain is used",
    );
    assert.match(r.data.error, /Caddy is not ready/);
    r = await call(
      "agent/heartbeat",
      "POST",
      { ...heartbeat, dockerAvailable: true, caddyAvailable: true },
      agentCredential,
    );
    assert.equal(r.status, 200);
    r = await call(`environments/${envId}/deploy`, "POST", {}, null, cookie);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const deploymentId = r.data.deployment.id;
    r = await call(`environments/${envId}/deploy`, "POST", {}, null, cookie);
    assert.equal(r.status, 409, "Concurrent deployment must be blocked");
    r = await call("agent/jobs/lease", "POST", {}, agentCredential);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const job = r.data.job;
    assert.equal(job.variables.API_SECRET, "never-read-back");
    assert.equal(job.registryToken, "registry-secret");
    assert.equal(job.volumePath, "/app/data");
    assert.equal(job.deploymentId, deploymentId);
    r = await call(
      `agent/jobs/${job.id}/progress`,
      "POST",
      { lease: job.lease, message: "Pulling image" },
      agentCredential,
    );
    assert.equal(r.status, 200);
    r = await call(
      `agent/jobs/${job.id}/complete`,
      "POST",
      { lease: "wrong", success: true },
      agentCredential,
    );
    assert.equal(r.status, 409, "Wrong lease must be rejected");
    r = await call(
      `agent/jobs/${job.id}/complete`,
      "POST",
      {
        lease: job.lease,
        success: false,
        message: "simulated container failure",
      },
      agentCredential,
    );
    assert.equal(r.status, 200);
    r = await call(
      `agent/jobs/${job.id}/complete`,
      "POST",
      { lease: job.lease, success: true },
      agentCredential,
    );
    assert.equal(r.status, 409, "Replay must be rejected");
    r = await call(
      `deployments/${deploymentId}`,
      "GET",
      undefined,
      null,
      cookie,
    );
    assert.equal(r.data.deployment.status, "failed");
    r = await call(`environments/${envId}/deploy`, "POST", {}, null, cookie);
    assert.equal(r.status, 201);
    const retryDeploymentId = r.data.deployment.id;
    r = await call("agent/jobs/lease", "POST", {}, agentCredential);
    const oldLease = r.data.job;
    await direct.query(
      "UPDATE deployment_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [oldLease.id],
    );
    r = await call("agent/jobs/lease", "POST", {}, agentCredential);
    const newLease = r.data.job;
    assert.equal(newLease.id, oldLease.id);
    assert.notEqual(newLease.lease, oldLease.lease);
    r = await call(
      `agent/jobs/${oldLease.id}/complete`,
      "POST",
      { lease: oldLease.lease, success: true },
      agentCredential,
    );
    assert.equal(r.status, 409);
    r = await call(
      `agent/jobs/${newLease.id}/complete`,
      "POST",
      {
        lease: newLease.lease,
        success: true,
        imageDigest: "ghcr.io/example/private@sha256:" + "a".repeat(64),
      },
      agentCredential,
    );
    assert.equal(r.status, 200);
    r = await call(
      `deployments/${retryDeploymentId}`,
      "GET",
      undefined,
      null,
      cookie,
    );
    assert.equal(r.data.deployment.status, "healthy");
    r = await call(
      `deployments/${retryDeploymentId}/redeploy`,
      "POST",
      {},
      null,
      cookie,
    );
    assert.equal(r.status, 201);
    r = await call("auth/register", "POST", {
      email: "other@example.com",
      password: "another-strong-password",
    });
    assert.equal(
      r.status,
      403,
      "Production registration requires the host code",
    );
    r = await call("auth/register", "POST", {
      email: "other@example.com",
      password: "another-strong-password",
      registrationCode,
    });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    const otherCookie = r.cookie.split(";")[0];
    r = await call("auth/register", "POST", {
      email: "other@example.com",
      password: "another-strong-password",
      registrationCode,
    });
    assert.equal(r.status, 409, "Email must be unique");
    r = await call("servers", "GET", undefined, null, otherCookie);
    assert.deepEqual(
      r.data.servers,
      [],
      "New account must start with no servers",
    );
    r = await call(`servers/${serverId}/pair`, "POST", {}, null, otherCookie);
    assert.equal(r.status, 404, "Other owner must not access server");
    r = await call(
      "servers",
      "POST",
      { name: "Second account VPS" },
      null,
      otherCookie,
    );
    assert.equal(r.status, 201);
    r = await call("servers", "GET", undefined, null, cookie);
    assert.equal(
      r.data.servers.some((server) => server.name === "Second account VPS"),
      false,
    );
    for (const endpoint of ["auth/me", "servers", "projects", "overview"]) {
      const timings = [];
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        const sample = await call(endpoint, "GET", undefined, null, cookie);
        assert.equal(sample.status, 200);
        timings.push(performance.now() - start);
      }
      timings.sort((a, b) => a - b);
      console.log(
        `API benchmark ${endpoint}: median=${timings[49].toFixed(1)}ms p95=${timings[94].toFixed(1)}ms n=100 sequential local`,
      );
    }
    r = await call("agent/rotate", "POST", {}, agentCredential);
    assert.equal(r.status, 200);
    const rotatedCredential = r.data.credential;
    r = await call("agent/jobs/lease", "POST", {}, rotatedCredential);
    assert.equal(r.status, 401, "Pending credential must not lease jobs");
    r = await call("agent/jobs/lease", "POST", {}, agentCredential);
    assert.equal(
      r.status,
      200,
      "Old credential remains usable until rotation confirmation",
    );
    const rotationJob = r.data.job;
    assert.ok(rotationJob);
    r = await call("agent/confirm-rotation", "POST", {}, rotatedCredential);
    assert.equal(r.status, 200);
    r = await call("agent/jobs/lease", "POST", {}, agentCredential);
    assert.equal(
      r.status,
      401,
      "Old credential must be revoked after confirmation",
    );
    const exhaustedJobId = rotationJob.id;
    await direct.query(
      "UPDATE deployment_jobs SET attempt=5,lease_expires_at=now()-interval '1 second' WHERE id=$1",
      [exhaustedJobId],
    );
    r = await call("agent/jobs/lease", "POST", {}, rotatedCredential);
    assert.equal(r.status, 200);
    assert.equal(r.data.job, null);
    const exhausted = await direct.query(
      "SELECT status FROM deployment_jobs WHERE id=$1",
      [exhaustedJobId],
    );
    assert.equal(exhausted.rows[0].status, "failed");
    await direct.query(
      "UPDATE servers SET last_seen_at=now()-interval '4 minutes' WHERE id=$1",
      [serverId],
    );
    r = await call("servers", "GET", undefined, null, cookie);
    assert.equal(
      r.data.servers[0].connected,
      false,
      "Stale heartbeat must show offline",
    );
    r = await call(`servers/${serverId}/revoke`, "POST", {}, null, cookie);
    assert.equal(r.status, 200);
    r = await call("agent/jobs/lease", "POST", {}, rotatedCredential);
    assert.equal(r.status, 401, "Revoked credential must be rejected");
  });
}
