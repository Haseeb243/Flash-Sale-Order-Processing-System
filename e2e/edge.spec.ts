import { test, expect } from '@playwright/test';
import { API_A, expectError, reset, stock } from './helpers';

test.describe('input edge cases', () => {
  test.beforeEach(async ({ request }) => {
    await reset(request);
  });

  test('invalid quantities and unknown fields are rejected without touching stock', async ({ request }) => {
    for (const quantity of ['1', 1.5, 0, -1, 101]) {
      const res = await request.post(`${API_A}/api/orders`, {
        data: { customer_id: 'c', product_id: 'mouse', quantity, idempotency_key: `k_${quantity}` },
      });
      await expectError(res, 400, 'VALIDATION_ERROR');
    }
    const extra = await request.post(`${API_A}/api/orders`, {
      data: { customer_id: 'c', product_id: 'mouse', quantity: 1, idempotency_key: 'k', price_cents: 1 },
    });
    await expectError(extra, 400, 'VALIDATION_ERROR');
    expect(await stock(request, 'mouse')).toBe(10);
  });

  test('whitespace-only ids are rejected', async ({ request }) => {
    const res = await request.post(`${API_A}/api/orders`, {
      data: { customer_id: '   ', product_id: 'mouse', quantity: 1, idempotency_key: 'k' },
    });
    await expectError(res, 400, 'VALIDATION_ERROR');
  });

  test('idempotency key accepted from header and required otherwise', async ({ request }) => {
    const body = { customer_id: 'c', product_id: 'mouse', quantity: 1 };
    const first = await request.post(`${API_A}/api/orders`, { data: body, headers: { 'Idempotency-Key': 'hk' } });
    const again = await request.post(`${API_A}/api/orders`, { data: body, headers: { 'Idempotency-Key': 'hk' } });
    expect(first.status()).toBe(201);
    expect(again.status()).toBe(200);
    expect((await again.json()).id).toBe((await first.json()).id);
    const missing = await request.post(`${API_A}/api/orders`, { data: body });
    const err = (await expectError(missing, 400, 'VALIDATION_ERROR')) as { error: { message: string } };
    expect(err.error.message).toContain('idempotency_key');
    expect(await stock(request, 'mouse')).toBe(9);
  });

  test('oversized body is 413 and unknown route is JSON 404', async ({ request }) => {
    const big = await request.post(`${API_A}/api/orders`, {
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ customer_id: 'x'.repeat(200_000) }),
    });
    expect(big.status()).toBe(413);
    await expectError(await request.get(`${API_A}/api/nope`), 404, 'NOT_FOUND');
  });
});
