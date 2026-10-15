// Typed API wrappers, models and formatting helpers.

export type OrderStatus = 'reserved' | 'confirmed' | 'cancelled' | 'expired'
export type PaymentStatus = 'payment_succeeded' | 'payment_failed'

export interface Product {
  id: string
  name: string
  price_cents: number
  stock: number
}

export interface Order {
  id: string
  customer_id: string
  product_id: string
  quantity: number
  amount_cents: number
  status: OrderStatus
  idempotency_key: string
  expires_at: string
  created_at: string
  updated_at: string
}

export interface CreateOrderInput {
  customer_id: string
  product_id: string
  quantity: number
  idempotency_key: string
}

export interface PaymentEventResponse {
  duplicate: boolean
  outcome?: string
  order: Order
}

export interface ExpireResponse {
  expired: number
  order_ids: string[]
}

interface ErrorBody {
  error?: { code?: string; message?: string }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  const text = await res.text()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
  }
  if (!res.ok) {
    const message = (body as ErrorBody | null)?.error?.message
    throw new Error(message ?? `Request failed with status ${res.status}`)
  }
  return body as T
}

export function fetchProducts(): Promise<Product[]> {
  return request<Product[]>('/products')
}

export function fetchOrders(customerId: string): Promise<Order[]> {
  return request<Order[]>(`/orders?customer_id=${encodeURIComponent(customerId)}`)
}

export function createOrder(input: CreateOrderInput): Promise<Order> {
  return request<Order>('/orders', { method: 'POST', body: JSON.stringify(input) })
}

export function sendPaymentEvent(orderId: string, status: PaymentStatus): Promise<PaymentEventResponse> {
  return request<PaymentEventResponse>('/webhooks/payment', {
    method: 'POST',
    body: JSON.stringify({
      event_id: `evt_${crypto.randomUUID()}`,
      order_id: orderId,
      status,
    }),
  })
}

export function expireReservations(): Promise<ExpireResponse> {
  return request<ExpireResponse>('/orders/expire', { method: 'POST' })
}

const usdFormatter = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function formatUsd(cents: number): string {
  return usdFormatter.format(cents / 100)
}

export function shortId(id: string): string {
  return id.slice(0, 8)
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Something went wrong'
}
