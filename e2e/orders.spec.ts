import { test, expect } from '@playwright/test';
import {
  API_A,
  API_B,
  createOrder,
  expectError,
  newOrderBody,
  readJson,
  reset,
  stock,
  uid,
  type Order,
} from './helpers';

test.describe('POST /api/orders', () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test('1. create order returns 201 reserved and decrements stock', async ({ request }) => {
    const before = await stock(request, 'laptop');

    const res = await createOrder(request, API_A, newOrderBody({ product_id: 'laptop', quantity: 1 }));
    expect(res.status()).toBe(201);
    const order = await readJson<Order>(res);
    expect(order.status).toBe('reserved');
    expect(order.product_id).toBe('laptop');
    expect(order.quantity).toBe(1);

    expect(await stock(request, 'laptop')).toBe(before - 1);
  });

  test('2. unknown product 404, quantity over stock 409, bad body 400', async ({ request }) => {
    const unknown = await createOrder(request, API_A, newOrderBody({ product_id: 'does-not-exist' }));
    await expectError(unknown, 404, 'PRODUCT_NOT_FOUND');

    // keyboard seed stock is 5
    const keyboardBefore = await stock(request, 'keyboard');
    expect(keyboardBefore).toBe(5);
    const tooMany = await createOrder(request, API_A, newOrderBody({ product_id: 'keyboard', quantity: 6 }));
    await expectError(tooMany, 409, 'INSUFFICIENT_STOCK');
    expect(await stock(request, 'keyboard')).toBe(keyboardBefore);

    const badQty = await createOrder(request, API_A, newOrderBody({ quantity: 0 }));
    await expectError(badQty, 400, 'VALIDATION_ERROR');

    const missingCustomer = await createOrder(request, API_A, {
      product_id: 'laptop',
      quantity: 1,
      idempotency_key: uid(),
    });
    await expectError(missingCustomer, 400, 'VALIDATION_ERROR');
  });

  test('3. idempotent replay returns same order, stock decremented once; key reuse with new body 422', async ({
    request,
  }) => {
    const before = await stock(request, 'laptop');
    const body = newOrderBody({ product_id: 'laptop', quantity: 1 });

    const first = await createOrder(request, API_A, body);
    expect(first.status()).toBe(201);
    const original = await readJson<Order>(first);

    const replay = await createOrder(request, API_A, body);
    expect(replay.status()).toBe(200);
    expect(replay.headers()['idempotent-replayed']).toBe('true');
    const replayed = await readJson<Order>(replay);
    expect(replayed.id).toBe(original.id);

    expect(await stock(request, 'laptop')).toBe(before - 1);

    const conflict = await createOrder(request, API_A, { ...body, quantity: 2 });
    await expectError(conflict, 422, 'IDEMPOTENCY_KEY_REUSED');
    expect(await stock(request, 'laptop')).toBe(before - 1);
  });

  test('4. same key and body sent concurrently x5 creates exactly one order and decrements stock once', async ({
    request,
  }) => {
    const before = await stock(request, 'laptop');
    const body = newOrderBody({ product_id: 'laptop', quantity: 1 });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => createOrder(request, API_A, body)),
    );
    const statuses = responses.map((r) => r.status());

    for (const status of statuses) {
      expect([200, 201]).toContain(status);
    }
    const created = statuses.filter((s) => s === 201).length;
    expect(created).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s !== 201).every((s) => s === 200)).toBe(true);

    const orders = await Promise.all(responses.map((r) => readJson<Order>(r)));
    const ids = new Set(orders.map((o) => o.id));
    expect(ids.size).toBe(1);

    expect(await stock(request, 'laptop')).toBe(before - 1);
  });

  test('5. last unit contended across instances A and B: one 201, one 409, stock 0', async ({ request }) => {
    // Seed laptop stock is 2: buy one so exactly one unit remains.
    const first = await createOrder(request, API_A, newOrderBody({ product_id: 'laptop', quantity: 1 }));
    expect(first.status()).toBe(201);
    expect(await stock(request, 'laptop')).toBe(1);

    const [a, b] = await Promise.all([
      createOrder(request, API_A, newOrderBody({ product_id: 'laptop', quantity: 1 })),
      createOrder(request, API_B, newOrderBody({ product_id: 'laptop', quantity: 1 })),
    ]);

    const statuses = [a.status(), b.status()].sort((x, y) => x - y);
    expect(statuses).toEqual([201, 409]);

    const loser = a.status() === 409 ? a : b;
    await expectError(loser, 409, 'INSUFFICIENT_STOCK');

    expect(await stock(request, 'laptop')).toBe(0);
  });

  test('6. 20 concurrent laptop requests across A and B: exactly 2 succeed, stock 0', async ({ request }) => {
    expect(await stock(request, 'laptop')).toBe(2);

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        createOrder(request, i % 2 === 0 ? API_A : API_B, newOrderBody({ product_id: 'laptop', quantity: 1 })),
      ),
    );
    const statuses = responses.map((r) => r.status());

    expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    expect(statuses.filter((s) => s === 409)).toHaveLength(18);

    for (const r of responses.filter((r) => r.status() === 409)) {
      const body = (await r.json()) as { error: { code: string } };
      expect(body.error.code).toBe('INSUFFICIENT_STOCK');
    }

    expect(await stock(request, 'laptop')).toBe(0);
  });
});
