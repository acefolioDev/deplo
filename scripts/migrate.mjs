import { spawnSync } from "node:child_process";
import pg from "pg";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

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
      env: process.env,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Prisma ${args.join(" ")} failed`);
}

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
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
