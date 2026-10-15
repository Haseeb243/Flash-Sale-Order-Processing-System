import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  API_A,
  createOrder,
  expireReservations,
  getOrder,
  newOrderBody,
  readJson,
  reset,
  stock,
  waitPastTtl,
  webhook,
  type Order,
  type WebhookResponse,
} from './helpers';

async function reserveLaptop(request: APIRequestContext): Promise<Order> {
  const res = await createOrder(request, API_A, newOrderBody({ product_id: 'laptop', quantity: 1 }));
  expect(res.status()).toBe(201);
  return readJson<Order>(res);
}

test.describe('reservation expiry', () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test('10. expire sweep releases reservation; late success webhook leaves it expired', async ({ request }) => {
    const order = await reserveLaptop(request);
    expect(await stock(request, 'laptop')).toBe(1);

    await waitPastTtl();

    const swept = await expireReservations(request);
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(swept.order_ids).toContain(order.id);

    const expired = await getOrder(request, order.id);
    expect(expired.status).toBe('expired');
    expect(await stock(request, 'laptop')).toBe(2);

    const late = await webhook(request, order.id, 'payment_succeeded');
    expect(late.status()).toBe(200);
    const lateBody = await readJson<WebhookResponse>(late);
    expect(lateBody.order.status).toBe('expired');

    expect((await getOrder(request, order.id)).status).toBe('expired');
    expect(await stock(request, 'laptop')).toBe(2);
  });

  test('11. late success webhook before any sweep: rejected_expired, expired, stock restored', async ({
    request,
  }) => {
    const order = await reserveLaptop(request);
    expect(await stock(request, 'laptop')).toBe(1);

    // No expire call: the webhook itself must detect the lapsed TTL.
    await waitPastTtl();

    const late = await webhook(request, order.id, 'payment_succeeded');
    expect(late.status()).toBe(200);
    const body = await readJson<WebhookResponse>(late);
    expect(body.duplicate).toBe(false);
    expect(body.outcome).toBe('rejected_expired');
    expect(body.order.status).toBe('expired');

    expect((await getOrder(request, order.id)).status).toBe('expired');
    expect(await stock(request, 'laptop')).toBe(2);
  });
});
