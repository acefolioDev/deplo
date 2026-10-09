import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const app = process.cwd();
const standalone = path.join(app, ".next/standalone/apps/web");
await fs.cp(
  path.join(app, ".next/static"),
  path.join(standalone, ".next/static"),
  { recursive: true },
);
await fs.cp(path.join(app, "public"), path.join(standalone, "public"), {
  recursive: true,
});
const child = spawn(process.execPath, [path.join(standalone, "server.js")], {
  stdio: "inherit",
  env: { ...process.env, HOSTNAME: process.env.HOSTNAME ?? "0.0.0.0" },
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => process.exit(signal ? 0 : (code ?? 1)));
