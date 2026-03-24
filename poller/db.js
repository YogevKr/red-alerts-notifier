import { Pool } from "pg";

export const DB_HEALTHCHECK_SQL = `
select
  current_database() as database_name,
  now() as server_time
`;

export function createDbPool({
  connectionString = process.env.POLLER_DATABASE_URL,
  PoolClass = Pool,
  applicationName = "red-alerts-poller",
  max = 10,
  idleTimeoutMillis = 30_000,
} = {}) {
  if (!connectionString) {
    throw new Error("POLLER_DATABASE_URL is required");
  }

  return new PoolClass({
    connectionString,
    application_name: applicationName,
    max,
    idleTimeoutMillis,
  });
}

export async function withDbClient(pool, callback) {
  const client = await pool.connect();

  try {
    return await callback(client);
  } finally {
    client.release();
  }
}

export async function queryRows(db, text, values = []) {
  const result = await db.query(text, values);
  return result.rows ?? [];
}

export async function withDbTransaction(pool, callback) {
  return withDbClient(pool, async (client) => {
    await client.query("BEGIN");

    try {
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
}

export async function checkDbConnection(db, now = Date.now()) {
  const startedAt = Date.now();
  const rows = await queryRows(db, DB_HEALTHCHECK_SQL);
  const row = rows[0] || {};
  const serverTime = row.server_time instanceof Date
    ? row.server_time.toISOString()
    : (row.server_time ? String(row.server_time) : null);

  return {
    checkedAt: new Date(now).toISOString(),
    latencyMs: Date.now() - startedAt,
    databaseName: row.database_name || null,
    serverTime,
  };
}
