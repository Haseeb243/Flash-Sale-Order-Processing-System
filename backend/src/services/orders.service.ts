import { createHash } from 'crypto';
import { config } from '../config';
import { pool, withTransaction } from '../db';
import { AppError } from '../errors';

export type OrderStatus = 'reserved' | 'confirmed' | 'cancelled' | 'expired';

export interface Order {
  id: string;
  customer_id: string;
  product_id: string;
  quantity: number;
  amount_cents: number;
  status: OrderStatus;
  idempotency_key: string;
  expires_at: Date;
  created_at: Date;
  updated_at: Date;
}

// request_hash is kept for replay checks but never returned to clients.
type StoredOrder = Order & { request_hash: string };

export const ORDER_COLUMNS =
  'id, customer_id, product_id, quantity, amount_cents, status, idempotency_key, expires_at, created_at, updated_at';

export interface CreateOrderInput {
  customerId: string;
  productId: string;
  quantity: number;
  idempotencyKey: string;
}

function requestHash(productId: string, quantity: number): string {
  return createHash('sha256').update(`${productId}:${quantity}`).digest('hex');
}

function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string }).code === '23505';
}

async function findByKey(customerId: string, idempotencyKey: string): Promise<StoredOrder | undefined> {
  const { rows } = await pool.query<StoredOrder>(
    `SELECT ${ORDER_COLUMNS}, request_hash FROM orders WHERE customer_id = $1 AND idempotency_key = $2`,
    [customerId, idempotencyKey],
  );
  return rows[0];
}

function replayOrThrow(stored: StoredOrder, hash: string): { order: Order; replayed: boolean } {
  if (stored.request_hash !== hash) {
    throw new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was already used with a different request');
  }
  const { request_hash: _hash, ...order } = stored;
  return { order, replayed: true };
}

export async function createOrder(input: CreateOrderInput): Promise<{ order: Order; replayed: boolean }> {
  const hash = requestHash(input.productId, input.quantity);

  const existing = await findByKey(input.customerId, input.idempotencyKey);
  if (existing) return replayOrThrow(existing, hash);

  try {
    const order = await withTransaction(async (client) => {
      // The conditional UPDATE takes the product row lock. A concurrent buyer blocks here and,
      // after we commit, re-checks stock against the committed value. Zero rows means no stock.
      const dec = await client.query<{ price_cents: number }>(
        'UPDATE products SET stock = stock - $2 WHERE id = $1 AND stock >= $2 RETURNING price_cents',
        [input.productId, input.quantity],
      );
      if (dec.rowCount === 0) {
        const exists = await client.query('SELECT 1 FROM products WHERE id = $1', [input.productId]);
        if (exists.rowCount === 0) throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
        throw new AppError(409, 'INSUFFICIENT_STOCK', 'Insufficient stock for requested quantity');
      }
      const amountCents = dec.rows[0].price_cents * input.quantity;

      const ins = await client.query<Order>(
        `INSERT INTO orders (customer_id, product_id, quantity, amount_cents, status, idempotency_key, request_hash, expires_at)
         VALUES ($1, $2, $3, $4, 'reserved', $5, $6, now() + make_interval(secs => $7))
         RETURNING ${ORDER_COLUMNS}`,
        [input.customerId, input.productId, input.quantity, amountCents, input.idempotencyKey, hash, config.reservationTtlSeconds],
      );
      return ins.rows[0];
    });
    return { order, replayed: false };
  } catch (err) {
    // The same key raced past the first lookup. The transaction has rolled back, which undoes
    // the stock decrement. Re-read the winning row and apply the replay rules.
    if (isUniqueViolation(err)) {
      const raced = await findByKey(input.customerId, input.idempotencyKey);
      if (raced) return replayOrThrow(raced, hash);
    }
    throw err;
  }
}

export async function getOrder(id: string): Promise<Order> {
  const { rows } = await pool.query<Order>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`, [id]);
  if (rows.length === 0) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
  return rows[0];
}

export async function listOrders(customerId: string): Promise<Order[]> {
  const { rows } = await pool.query<Order>(
    `SELECT ${ORDER_COLUMNS} FROM orders WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`,
    [customerId],
  );
  return rows;
}
