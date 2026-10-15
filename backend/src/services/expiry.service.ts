import { withTransaction } from '../db';
import { releaseStock } from './products.service';

export async function expireReservations(): Promise<{ expired: number; order_ids: string[] }> {
  return withTransaction(async (client) => {
    // SKIP LOCKED: rows held by an in-flight webhook are left for the next run.
    const { rows } = await client.query<{ id: string; product_id: string; quantity: number }>(
      `UPDATE orders SET status = 'expired', updated_at = now()
       WHERE id IN (
         SELECT id FROM orders WHERE status = 'reserved' AND expires_at <= now()
         FOR UPDATE SKIP LOCKED
       )
       RETURNING id, product_id, quantity`,
    );

    // Sorted product order keeps product lock acquisition deterministic across concurrent sweepers.
    const perProduct = new Map<string, number>();
    for (const r of rows) perProduct.set(r.product_id, (perProduct.get(r.product_id) ?? 0) + r.quantity);
    for (const productId of [...perProduct.keys()].sort()) {
      await releaseStock(client, productId, perProduct.get(productId) ?? 0);
    }

    return { expired: rows.length, order_ids: rows.map((r) => r.id) };
  });
}
