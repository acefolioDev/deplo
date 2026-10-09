import { spawn } from "node:child_process";
import { loadLocalEnv } from "./load-local-env.mjs";

loadLocalEnv();
if (!process.env.DATABASE_URL && process.env.DIRECT_URL) {
  process.env.DATABASE_URL = process.env.DIRECT_URL;
}
if (!process.env.DATABASE_URL) {
  throw new Error(
    "Set DATABASE_URL or DIRECT_URL in the repository's .env file or your shell",
  );
}

const child = spawn("npm", ["run", "dev", "-w", "@deplo/web"], {
  stdio: "inherit",
  env: process.env,
});
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
