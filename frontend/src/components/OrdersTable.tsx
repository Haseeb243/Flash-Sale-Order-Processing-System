import type { ReactNode } from 'react'
import { formatUsd, shortId, type Order, type PaymentStatus } from '../api'

interface Props {
  orders: Order[]
  productNames: Record<string, string>
  loading: boolean
  error: string | null
  paying: Record<string, boolean>
  onPay: (order: Order, status: PaymentStatus) => void
}

export default function OrdersTable({ orders, productNames, loading, error, paying, onPay }: Props) {
  let body: ReactNode
  if (loading && orders.length === 0) {
    body = (
      <tr>
        <td colSpan={7} className="muted">Loading orders…</td>
      </tr>
    )
  } else if (error) {
    body = (
      <tr>
        <td colSpan={7} className="error-text">Failed to load orders: {error}</td>
      </tr>
    )
  } else if (orders.length === 0) {
    body = (
      <tr>
        <td colSpan={7} className="muted">No orders for this customer yet.</td>
      </tr>
    )
  } else {
    body = orders.map((o) => {
      const isPaying = Boolean(paying[o.id])
      return (
        <tr key={o.id} data-testid={`order-row-${o.id}`}>
          <td title={o.id} className="mono">{shortId(o.id)}</td>
          <td>{productNames[o.product_id] ?? o.product_id}</td>
          <td className="num">{o.quantity}</td>
          <td className="num">{formatUsd(o.amount_cents)}</td>
          <td>
            <span className={`badge badge-${o.status}`} data-testid={`order-status-${o.id}`}>
              {o.status}
            </span>
          </td>
          <td>{new Date(o.expires_at).toLocaleTimeString()}</td>
          <td>
            {o.status === 'reserved' && (
              <div className="actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  data-testid={`pay-success-${o.id}`}
                  disabled={isPaying}
                  onClick={() => onPay(o, 'payment_succeeded')}
                >
                  Pay
                </button>
                <button
                  type="button"
                  className="btn"
                  data-testid={`pay-fail-${o.id}`}
                  disabled={isPaying}
                  onClick={() => onPay(o, 'payment_failed')}
                >
                  Fail payment
                </button>
              </div>
            )}
          </td>
        </tr>
      )
    })
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Order</th>
          <th>Product</th>
          <th className="num">Qty</th>
          <th className="num">Amount</th>
          <th>Status</th>
          <th>Expires</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  )
}
