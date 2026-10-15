import fs from 'fs';
import path from 'path';
import { withTransaction } from './db';

const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

export const SEED_PRODUCTS: { id: string; name: string; price_cents: number; stock: number }[] = [
  { id: 'laptop', name: 'Laptop', price_cents: 100000, stock: 2 },
  { id: 'keyboard', name: 'Keyboard', price_cents: 10000, stock: 5 },
  { id: 'mouse', name: 'Mouse', price_cents: 5000, stock: 10 },
];

// The advisory lock serialises concurrent instances starting at once; the
// xact variant releases it automatically on COMMIT/ROLLBACK.
export async function migrate(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(424242)');
    await client.query(schemaSql);
    for (const p of SEED_PRODUCTS) {
      await client.query(
        'INSERT INTO products (id, name, price_cents, stock) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING',
        [p.id, p.name, p.price_cents, p.stock],
      );
    }
  });
}
