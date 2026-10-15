import { expect, type APIRequestContext, type APIResponse } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export const API_A = 'http://localhost:4000';
export const API_B = 'http://localhost:4001';

/** TTL the backends run with (RESERVATION_TTL_SECONDS=3) plus margin. */
export const TTL_WAIT_MS = 3500;

export type OrderStatus = 'reserved' | 'confirmed' | 'cancelled' | 'expired';
export type PaymentStatus = 'payment_succeeded' | 'payment_failed';

export interface Order {
  id: string;
  customer_id: string;
  product_id: string;
  quantity: number;
  amount_cents: number;
  status: OrderStatus;
  idempotency_key: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface WebhookResponse {
  duplicate: boolean;
  outcome?: string;
  order: Order;
}

export interface ExpireResponse {
  expired: number;
  order_ids: string[];
}

export interface CreateOrderBody {
  customer_id: string;
  product_id: string;
  quantity: number;
  idempotency_key: string;
}

export function uid(): string {
  return randomUUID();
}

/** Valid create-order body with a unique customer and idempotency key unless overridden. */
export function newOrderBody(overrides: Partial<CreateOrderBody> = {}): CreateOrderBody {
  return {
    customer_id: `customer_${uid()}`,
    product_id: 'laptop',
    quantity: 1,
    idempotency_key: uid(),
    ...overrides,
  };
}

export async function readJson<T>(res: APIResponse): Promise<T> {
  return (await res.json()) as T;
}

/** Asserts HTTP status and API error code, returns parsed body. */
export async function expectError(res: APIResponse, status: number, code: string): Promise<unknown> {
  expect(res.status(), `expected ${status}`).toBe(status);
  const body = (await res.json()) as { error?: { code?: string } };
  expect(body.error?.code).toBe(code);
  return body;
}

/** Dev reset: truncates orders and payment events, restores seed stock. */
export async function reset(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API_A}/api/dev/reset`);
  expect(res.ok(), `reset failed: ${res.status()}`).toBeTruthy();
}

/** Current stock for a product, read from GET /api/products on API_A. */
export async function stock(request: APIRequestContext, productId: string): Promise<number> {
  const res = await request.get(`${API_A}/api/products`);
  expect(res.ok(), `products failed: ${res.status()}`).toBeTruthy();
  const products = (await res.json()) as Array<{ id: string; stock: number }>;
  const product = products.find((p) => p.id === productId);
  if (!product) throw new Error(`product ${productId} not found`);
  return product.stock;
}

/** POST /api/orders against the given backend instance. Returns the raw APIResponse. */
export function createOrder(
  request: APIRequestContext,
  base: string,
  body: object,
): Promise<APIResponse> {
  return request.post(`${base}/api/orders`, { data: body });
}

export async function getOrder(request: APIRequestContext, orderId: string): Promise<Order> {
  const res = await request.get(`${API_A}/api/orders/${orderId}`);
  expect(res.status(), `get order failed`).toBe(200);
  return readJson<Order>(res);
}

/** POST /api/webhooks/payment. Event id defaults to a fresh evt_<uuid>. */
export function webhook(
  request: APIRequestContext,
  orderId: string,
  status: PaymentStatus,
  eventId: string = `evt_${uid()}`,
  base: string = API_A,
): Promise<APIResponse> {
  return request.post(`${base}/api/webhooks/payment`, {
    data: { event_id: eventId, order_id: orderId, status },
  });
}

/** POST /api/orders/expire on API_A. */
export async function expireReservations(request: APIRequestContext): Promise<ExpireResponse> {
  const res = await request.post(`${API_A}/api/orders/expire`);
  expect(res.status(), 'expire failed').toBe(200);
  return readJson<ExpireResponse>(res);
}

/** Sleep past the reservation TTL so the order is expired. */
export async function waitPastTtl(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, TTL_WAIT_MS));
}
