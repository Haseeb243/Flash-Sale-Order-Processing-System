import { useState, type ReactNode } from 'react'
import { formatUsd, type Product } from '../api'

interface Props {
  products: Product[]
  loading: boolean
  error: string | null
  reserving: Record<string, boolean>
  onReserve: (productId: string, quantity: number) => void
}

export default function ProductsTable({ products, loading, error, reserving, onReserve }: Props) {
  const [quantities, setQuantities] = useState<Record<string, string>>({})

  let body: ReactNode
  if (loading && products.length === 0) {
    body = (
      <tr>
        <td colSpan={5} className="muted">Loading products…</td>
      </tr>
    )
  } else if (error) {
    body = (
      <tr>
        <td colSpan={5} className="error-text">Failed to load products: {error}</td>
      </tr>
    )
  } else if (products.length === 0) {
    body = (
      <tr>
        <td colSpan={5} className="muted">No products available.</td>
      </tr>
    )
  } else {
    body = products.map((p) => {
      const isReserving = Boolean(reserving[p.id])
      const qty = quantities[p.id] ?? '1'
      return (
        <tr key={p.id} data-testid={`product-row-${p.id}`}>
          <td>{p.name}</td>
          <td className="num">{formatUsd(p.price_cents)}</td>
          <td className="num" data-testid={`stock-${p.id}`}>{p.stock}</td>
          <td>
            <input
              type="number"
              min={1}
              max={100}
              className="qty-input"
              data-testid={`qty-${p.id}`}
              aria-label={`Quantity for ${p.name}`}
              value={qty}
              onChange={(e) => setQuantities((prev) => ({ ...prev, [p.id]: e.target.value }))}
            />
          </td>
          <td>
            <button
              type="button"
              className="btn btn-primary"
              data-testid={`reserve-${p.id}`}
              disabled={isReserving}
              onClick={() => onReserve(p.id, Number(qty))}
            >
              {isReserving ? 'Reserving…' : 'Reserve'}
            </button>
          </td>
        </tr>
      )
    })
  }

  return (
    <table className="table">
      <thead>
        <tr>
          <th>Name</th>
          <th className="num">Price</th>
          <th className="num">Stock</th>
          <th>Qty</th>
          <th></th>
        </tr>
      </thead>
      <tbody>{body}</tbody>
    </table>
  )
}
