import pg from "pg";

const globalPool = globalThis as typeof globalThis & { deploPool?: pg.Pool };
export const pool =
  globalPool.deploPool ??
  new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 3_000,
  });
if (process.env.NODE_ENV !== "production") globalPool.deploPool = pool;

export async function transaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
