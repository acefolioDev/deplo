import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const statePath = path.join(root, ".deplo-local-demo.json");
const origin = "http://localhost:3456";
process.chdir(root);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} exited with ${result.status}`);
}

async function freePort() {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(3456, "127.0.0.1", () => server.close(resolve));
  });
}

async function state() {
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const database = `deplo_demo_${randomBytes(6).toString("hex")}`;
  const adminURL =
    process.env.DEPLO_DEMO_POSTGRES_URL ??
    `postgres://${encodeURIComponent(os.userInfo().username)}@localhost:5432/postgres`;
  const databaseURL = new URL(adminURL);
  databaseURL.pathname = `/${database}`;
  const value = {
    database,
    adminURL,
    databaseURL: databaseURL.toString(),
    bootstrapToken: randomBytes(32).toString("hex"),
    encryptionKey: randomBytes(32).toString("base64"),
    email: "demo@deplo.local",
    password: randomBytes(18).toString("base64url"),
  };
  await fs.writeFile(statePath, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  return value;
}

async function databaseReady(config) {
  const admin = new pg.Client({ connectionString: config.adminURL });
  await admin.connect();
  try {
    const found = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname=$1",
      [config.database],
    );
    if (!found.rowCount)
      await admin.query(`CREATE DATABASE "${config.database}"`);
  } finally {
    await admin.end();
  }
}

async function waitForServer(child) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null)
      throw new Error("The web server exited before becoming ready");
    try {
      const response = await fetch(origin + "/api/auth/me");
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for the web server");
}

let child;
try {
  await freePort();
  if (!(await fs.stat(path.join(root, "node_modules")).catch(() => null)))
    run("npm", ["install"]);
  const config = await state();
  if (!/^deplo_demo_[0-9a-f]{12}$/.test(config.database))
    throw new Error("Invalid demo database name in saved state");
  await databaseReady(config);
  const env = {
    ...process.env,
    DATABASE_URL: config.databaseURL,
    PUBLIC_URL: origin,
    BOOTSTRAP_TOKEN: config.bootstrapToken,
    ENCRYPTION_KEY: config.encryptionKey,
    HOSTNAME: "127.0.0.1",
    PORT: "3456",
    DEPLO_LOCAL_DEMO: "1",
  };
  run(process.execPath, ["scripts/migrate.mjs"], env);
  run("npm", ["run", "build"], env);
  child = spawn(
    process.execPath,
    [path.join(root, "apps/web/scripts/start.mjs")],
    { cwd: path.join(root, "apps/web"), env, stdio: "inherit" },
  );
  await waitForServer(child);
  const db = new pg.Client({ connectionString: config.databaseURL });
  await db.connect();
  let hasOwner;
  try {
    hasOwner = (await db.query("SELECT 1 FROM users LIMIT 1")).rowCount > 0;
  } finally {
    await db.end();
  }
  if (!hasOwner) {
    const response = await fetch(origin + "/api/auth/bootstrap", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: config.email,
        password: config.password,
        bootstrapToken: config.bootstrapToken,
      }),
    });
    if (!response.ok)
      throw new Error(
        `Demo owner setup failed: ${response.status} ${await response.text()}`,
      );
  }
  console.log(`\nDeplo is ready: ${origin}`);
  console.log(`Email: ${config.email}`);
  console.log(`Password: ${config.password}`);
  console.log("This demo is bound to this Mac only. Press Ctrl+C to stop it.");
  console.log(`Credentials for a later run are in ${statePath}\n`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => child.kill("SIGTERM"));
  child.on("exit", (code) => process.exit(code ?? 0));
} catch (error) {
  if (child && child.exitCode === null) child.kill("SIGTERM");
  console.error(`Demo setup failed: ${error.message}`);
  console.error(
    "Check that local PostgreSQL is running. If it uses another role, set DEPLO_DEMO_POSTGRES_URL to an admin connection URL.",
  );
  process.exitCode = 1;
}
