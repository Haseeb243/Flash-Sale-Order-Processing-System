import { Pool, PoolClient } from 'pg';
import { config } from './config';

// Bounded waits: under a flash-sale burst requests fail fast (503, retryable) instead of
// queueing forever on the pool or on a hot product row lock.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: config.db.poolMax,
  connectionTimeoutMillis: config.db.connectTimeoutMs,
  statement_timeout: config.db.statementTimeoutMs,
  lock_timeout: config.db.lockTimeoutMs,
});

pool.on('error', (err) => console.error('idle pg client error', err));

export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // If ROLLBACK itself fails the connection is unusable: destroy it, keep the original error.
    await client.query('ROLLBACK').catch((rollbackErr: Error) => {
      broken = rollbackErr;
    });
    throw err;
  } finally {
    client.release(broken);
  }
}
