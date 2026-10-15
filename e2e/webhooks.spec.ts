import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  API_A,
  createOrder,
  newOrderBody,
  readJson,
  reset,
  stock,
  uid,
  webhook,
  type Order,
  type WebhookResponse,
  expectError,
} from './helpers';

async function reserveLaptop(request: APIRequestContext): Promise<Order> {
  const res = await createOrder(request, API_A, newOrderBody({ product_id: 'laptop', quantity: 1 }));
  expect(res.status()).toBe(201);
  return readJson<Order>(res);
}

test.describe('POST /api/webhooks/payment', () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test('7. success confirms; duplicate event is a no-op; conflicting failure is ignored', async ({ request }) => {
    // laptop seed 2, one reserved -> 1
    const order = await reserveLaptop(request);
    expect(await stock(request, 'laptop')).toBe(1);

    const eventId = `evt_${uid()}`;
    const first = await webhook(request, order.id, 'payment_succeeded', eventId);
    expect(first.status()).toBe(200);
    const firstBody = await readJson<WebhookResponse>(first);
    expect(firstBody.duplicate).toBe(false);
    expect(firstBody.outcome).toBe('applied_confirmed');
    expect(firstBody.order.status).toBe('confirmed');

    const dup = await webhook(request, order.id, 'payment_succeeded', eventId);
    expect(dup.status()).toBe(200);
    const dupBody = await readJson<WebhookResponse>(dup);
    expect(dupBody.duplicate).toBe(true);
    expect(dupBody.order.status).toBe('confirmed');

    const conflict = await webhook(request, order.id, 'payment_failed');
    expect(conflict.status()).toBe(200);
    const conflictBody = await readJson<WebhookResponse>(conflict);
    expect(conflictBody.duplicate).toBe(false);
    expect(conflictBody.outcome).toBe('ignored_confirmed');
    expect(conflictBody.order.status).toBe('confirmed');

    expect(await stock(request, 'laptop')).toBe(1);
  });

  test('8. failure cancels and restores stock; later success is ignored', async ({ request }) => {
    const order = await reserveLaptop(request);
    expect(await stock(request, 'laptop')).toBe(1);

    const fail = await webhook(request, order.id, 'payment_failed');
    expect(fail.status()).toBe(200);
    const failBody = await readJson<WebhookResponse>(fail);
    expect(failBody.duplicate).toBe(false);
    expect(failBody.outcome).toBe('applied_cancelled');
    expect(failBody.order.status).toBe('cancelled');
    expect(await stock(request, 'laptop')).toBe(2);

    const late = await webhook(request, order.id, 'payment_succeeded');
    expect(late.status()).toBe(200);
    const lateBody = await readJson<WebhookResponse>(late);
    expect(lateBody.outcome).toBe('ignored_cancelled');
    expect(lateBody.order.status).toBe('cancelled');
    expect(await stock(request, 'laptop')).toBe(2);
  });

  test('9. five concurrent distinct failure events restore stock exactly once', async ({ request }) => {
    const order = await reserveLaptop(request);
    expect(await stock(request, 'laptop')).toBe(1);

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => webhook(request, order.id, 'payment_failed')),
    );
    for (const r of responses) {
      expect(r.status()).toBe(200);
    }
    const bodies = await Promise.all(responses.map((r) => readJson<WebhookResponse>(r)));

    expect(bodies.every((b) => b.duplicate === false)).toBe(true);
    expect(bodies.filter((b) => b.outcome === 'applied_cancelled')).toHaveLength(1);
    expect(bodies.filter((b) => b.outcome === 'ignored_cancelled')).toHaveLength(4);
    expect(bodies.every((b) => b.order.status === 'cancelled')).toBe(true);

    expect(await stock(request, 'laptop')).toBe(2);
  });

  test('10. event for unknown order is not recorded, so a retry is processed again (404, not duplicate)', async ({ request }) => {
    const eventId = `evt_${uid()}`;
    const missingOrderId = uid();
    await expectError(await webhook(request, missingOrderId, 'payment_succeeded', eventId), 404, 'ORDER_NOT_FOUND');
    await expectError(await webhook(request, missingOrderId, 'payment_succeeded', eventId), 404, 'ORDER_NOT_FOUND');
  });
});
