import type { PoolClient } from 'pg';
import { pool, withTransaction } from '../db';
import { SEED_PRODUCTS } from '../migrate';

export interface Product {
  id: string;
  name: string;
  price_cents: number;
  stock: number;
}

export async function listProducts(): Promise<Product[]> {
  const { rows } = await pool.query<Product>('SELECT id, name, price_cents, stock FROM products ORDER BY price_cents DESC');
  return rows;
}

export async function releaseStock(client: PoolClient, productId: string, quantity: number): Promise<void> {
  await client.query('UPDATE products SET stock = stock + $2 WHERE id = $1', [productId, quantity]);
}

export async function resetDemoData(): Promise<void> {
  await withTransaction(async (client) => {
    await client.query('TRUNCATE payment_events, orders');
    for (const p of SEED_PRODUCTS) {
      await client.query('UPDATE products SET stock = $2 WHERE id = $1', [p.id, p.stock]);
    }
  });
}
