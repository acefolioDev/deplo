import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

export function loadLocalEnv() {
  // Existing shell values win, followed by .env.local and then .env.
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) loadEnvFile(file);
  }
}
