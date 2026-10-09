import { spawnSync } from "node:child_process";
import pg from "pg";
import { loadLocalEnv } from "./load-local-env.mjs";

loadLocalEnv();

const migrationURL = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
if (!migrationURL)
  throw new Error(
    "Set DIRECT_URL or DATABASE_URL in the repository's .env file or your shell",
  );
const migrationEnv = { ...process.env, DATABASE_URL: migrationURL };

function prisma(...args) {
  const result = spawnSync(
    "npx",
    [
      "--no-install",
      "prisma",
      ...args,
      "--schema",
      "apps/web/prisma/schema.prisma",
    ],
    {
      stdio: "inherit",
      env: migrationEnv,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Prisma ${args.join(" ")} failed`);
}

const db = new pg.Client({ connectionString: migrationURL });
await db.connect();
let legacy;
let prismaHistory;
try {
  const result = await db.query(
    "SELECT to_regclass('public.schema_migrations') IS NOT NULL AS legacy, to_regclass('public._prisma_migrations') IS NOT NULL AS prisma_history",
  );
  legacy = result.rows[0].legacy;
  prismaHistory = result.rows[0].prisma_history;
} finally {
  await db.end();
}

// Existing Deplo databases have the same initial schema under the old migration ledger.
if (legacy && !prismaHistory)
  prisma("migrate", "resolve", "--applied", "20261010000000_initial");
prisma("migrate", "deploy");
prisma("generate");
