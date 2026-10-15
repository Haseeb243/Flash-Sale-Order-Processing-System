import type { PoolClient } from 'pg';
import { withTransaction } from '../db';
import { AppError } from '../errors';
import { Order, ORDER_COLUMNS } from './orders.service';
import { releaseStock } from './products.service';

export interface PaymentEventInput {
  eventId: string;
  orderId: string;
  status: 'payment_succeeded' | 'payment_failed';
}

export type PaymentResult = { duplicate: true; order: Order } | { duplicate: false; outcome: string; order: Order };

async function expireNow(client: PoolClient, order: Order): Promise<Order> {
  await releaseStock(client, order.product_id, order.quantity);
  const { rows } = await client.query<Order>(
    `UPDATE orders SET status = 'expired', updated_at = now()
     WHERE id = $1 AND status = 'reserved' RETURNING ${ORDER_COLUMNS}`,
    [order.id],
  );
  return rows[0];
}

export async function handlePaymentEvent(input: PaymentEventInput): Promise<PaymentResult> {
  // Event record and state change share one transaction: if processing fails the event is
  // rolled back too, so a provider retry is processed instead of being treated as a duplicate.
  return withTransaction(async (client) => {
    // Recording the event first makes redelivery a no-op. A concurrent delivery of the same
    // event blocks on this insert until the first transaction commits, then sees the conflict.
    const ins = await client.query(
      `INSERT INTO payment_events (event_id, order_id, status, outcome)
       VALUES ($1, $2, $3, 'pending') ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [input.eventId, input.orderId, input.status],
    );
    if (ins.rowCount === 0) {
      // Read through the transaction's own client: borrowing a second pool connection while
      // holding this one starves the pool under a burst of redeliveries.
      const prior = await client.query<Order>(
        `SELECT ${ORDER_COLUMNS} FROM orders
         WHERE id = (SELECT order_id FROM payment_events WHERE event_id = $1)`,
        [input.eventId],
      );
      return { duplicate: true, order: prior.rows[0] };
    }

    // Lock order: order row, then product row. Expiry follows the same order, so no deadlock.
    const found = await client.query<Order & { is_expired: boolean }>(
      `SELECT ${ORDER_COLUMNS}, expires_at <= now() AS is_expired FROM orders WHERE id = $1 FOR UPDATE`,
      [input.orderId],
    );
    if (found.rows.length === 0) throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    const { is_expired: isExpired, ...order } = found.rows[0];

    let outcome: string;
    let updated: Order = order;

    if (order.status !== 'reserved') {
      outcome = `ignored_${order.status}`;
    } else if (input.status === 'payment_succeeded' && !isExpired) {
      outcome = 'applied_confirmed';
      updated = (
        await client.query<Order>(
          `UPDATE orders SET status = 'confirmed', updated_at = now()
           WHERE id = $1 AND status = 'reserved' RETURNING ${ORDER_COLUMNS}`,
          [order.id],
        )
      ).rows[0];
    } else if (input.status === 'payment_succeeded') {
      // Late payment never confirms an expired reservation.
      outcome = 'rejected_expired';
      updated = await expireNow(client, order);
    } else {
      outcome = 'applied_cancelled';
      await releaseStock(client, order.product_id, order.quantity);
      updated = (
        await client.query<Order>(
          `UPDATE orders SET status = 'cancelled', updated_at = now()
           WHERE id = $1 AND status = 'reserved' RETURNING ${ORDER_COLUMNS}`,
          [order.id],
        )
      ).rows[0];
    }

    await client.query('UPDATE payment_events SET outcome = $2 WHERE event_id = $1', [input.eventId, outcome]);
    return { duplicate: false, outcome, order: updated };
  });
}
