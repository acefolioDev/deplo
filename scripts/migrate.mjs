import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
try {
  await db.query('BEGIN');
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  for (const name of (await fs.readdir('packages/db/migrations')).filter(x => x.endsWith('.sql')).sort()) {
    const exists = await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
    if (exists.rowCount) continue;
    await db.query(await fs.readFile(path.join('packages/db/migrations', name), 'utf8'));
    await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    console.log(`Applied ${name}`);
  }
  await db.query('COMMIT');
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally { await db.end(); }
