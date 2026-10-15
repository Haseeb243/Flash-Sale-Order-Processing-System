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

export type PaymentResult =
  | { duplicate: true; order: Order }
  | { duplicate: false; outcome: string; refund_required: boolean; order: Order };

// Every exit from 'reserved' goes through here, so the status guard and the stock release can
// never drift apart. Caller must hold the order row lock (lock order: order row, then product row).
async function transition(client: PoolClient, order: Order, to: 'confirmed' | 'cancelled' | 'expired'): Promise<Order> {
  const { rows } = await client.query<Order>(
    `UPDATE orders SET status = $2, updated_at = now()
     WHERE id = $1 AND status = 'reserved' RETURNING ${ORDER_COLUMNS}`,
    [order.id, to],
  );
  if (rows.length > 0 && to !== 'confirmed') await releaseStock(client, order.product_id, order.quantity);
  return rows[0] ?? order;
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
      const prior = await client.query<{ order_id: string; status: string }>(
        'SELECT order_id, status FROM payment_events WHERE event_id = $1',
        [input.eventId],
      );
      const { order_id: priorOrderId, status: priorStatus } = prior.rows[0];
      if (priorOrderId !== input.orderId || priorStatus !== input.status) {
        throw new AppError(409, 'EVENT_ID_CONFLICT', 'event_id was already used for a different order or status');
      }
      const current = await client.query<Order>(`SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1`, [priorOrderId]);
      return { duplicate: true, order: current.rows[0] };
    }

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
    } else if (input.status === 'payment_failed') {
      outcome = 'applied_cancelled';
      updated = await transition(client, order, 'cancelled');
    } else if (isExpired) {
      // Late payment never confirms an expired reservation.
      outcome = 'rejected_expired';
      updated = await transition(client, order, 'expired');
    } else {
      outcome = 'applied_confirmed';
      updated = await transition(client, order, 'confirmed');
    }

    // Money captured that did not confirm this order (second payment, payment after cancel or
    // expiry) is flagged so a reconciliation job can refund it.
    const refundRequired = input.status === 'payment_succeeded' && outcome !== 'applied_confirmed';
    await client.query('UPDATE payment_events SET outcome = $2, refund_required = $3 WHERE event_id = $1', [
      input.eventId,
      outcome,
      refundRequired,
    ]);
    return { duplicate: false, outcome, refund_required: refundRequired, order: updated };
  });
}
