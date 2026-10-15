import { Pool, PoolClient } from 'pg';
import { config } from './config';

// Bounded waits: under a flash-sale burst requests fail fast (503, retryable) instead of
// queueing forever on the pool or on a hot product row lock.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  connectionTimeoutMillis: 5000,
  statement_timeout: 5000,
  lock_timeout: 3000,
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
