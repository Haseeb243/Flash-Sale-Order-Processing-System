import { test, expect } from '@playwright/test';
import { API_A, createOrder, newOrderBody, readJson, reset, uid, webhook, type Order } from './helpers';

test.describe('connection pool safety', () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test('30 concurrent deliveries of one event to one instance complete (no pool starvation)', async ({ request }) => {
    const res = await createOrder(request, API_A, newOrderBody({ product_id: 'mouse', quantity: 1 }));
    const order = await readJson<Order>(res);
    const eventId = `evt_${uid()}`;
    const results = await Promise.all(
      Array.from({ length: 30 }, () => webhook(request, order.id, 'payment_succeeded', eventId, API_A, )),
    );
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(results.every((r) => r.status() === 200)).toBe(true);
    expect(bodies.filter((b) => b.duplicate === false)).toHaveLength(1);
    expect(bodies.every((b) => b.order.status === 'confirmed')).toBe(true);
  });
});
