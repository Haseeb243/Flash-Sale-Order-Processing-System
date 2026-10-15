import { useEffect, useMemo, useState } from 'react'
import {
  createOrder,
  errorMessage,
  expireReservations,
  fetchOrders,
  fetchProducts,
  sendPaymentEvent,
  shortId,
  type Order,
  type PaymentStatus,
  type Product,
} from './api'
import OrdersTable from './components/OrdersTable'
import ProductsTable from './components/ProductsTable'

type Banner = { variant: 'success' | 'error'; text: string }

export default function App() {
  const [customerId, setCustomerId] = useState('customer_1')
  const [reloadKey, setReloadKey] = useState(0)

  const [products, setProducts] = useState<Product[]>([])
  const [productsLoading, setProductsLoading] = useState(true)
  const [productsError, setProductsError] = useState<string | null>(null)

  const [orders, setOrders] = useState<Order[]>([])
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [ordersError, setOrdersError] = useState<string | null>(null)

  const [banner, setBanner] = useState<Banner | null>(null)
  const [reserving, setReserving] = useState<Record<string, boolean>>({})
  const [paying, setPaying] = useState<Record<string, boolean>>({})
  const [expiring, setExpiring] = useState(false)

  const cid = customerId.trim()
  const reload = () => setReloadKey((k) => k + 1)

  // Products: load on mount and on refresh.
  useEffect(() => {
    let active = true
    setProductsLoading(true)
    setProductsError(null)
    fetchProducts()
      .then((data) => {
        if (active) setProducts(data)
      })
      .catch((err) => {
        if (active) setProductsError(errorMessage(err))
      })
      .finally(() => {
        if (active) setProductsLoading(false)
      })
    return () => {
      active = false
    }
  }, [reloadKey])

  // Orders: load on mount, on customer change, and on refresh.
  useEffect(() => {
    let active = true
    if (!cid) {
      setOrders([])
      setOrdersError(null)
      setOrdersLoading(false)
      return
    }
    setOrdersLoading(true)
    setOrdersError(null)
    fetchOrders(cid)
      .then((data) => {
        if (active) setOrders(data)
      })
      .catch((err) => {
        if (active) setOrdersError(errorMessage(err))
      })
      .finally(() => {
        if (active) setOrdersLoading(false)
      })
    return () => {
      active = false
    }
  }, [cid, reloadKey])

  const productNames = useMemo(
    () => Object.fromEntries(products.map((p) => [p.id, p.name])),
    [products],
  )

  async function handleReserve(productId: string, quantity: number) {
    setReserving((prev) => ({ ...prev, [productId]: true }))
    try {
      const order = await createOrder({
        customer_id: cid,
        product_id: productId,
        quantity,
        idempotency_key: crypto.randomUUID(),
      })
      setBanner({
        variant: 'success',
        text: `Order ${shortId(order.id)} reserved — pay within 2 minutes`,
      })
      reload()
    } catch (err) {
      setBanner({ variant: 'error', text: errorMessage(err) })
    } finally {
      setReserving((prev) => ({ ...prev, [productId]: false }))
    }
  }

  async function handlePay(order: Order, status: PaymentStatus) {
    setPaying((prev) => ({ ...prev, [order.id]: true }))
    try {
      const res = await sendPaymentEvent(order.id, status)
      setBanner({
        variant: 'success',
        text: `Order ${shortId(order.id)} is now ${res.order.status}`,
      })
      reload()
    } catch (err) {
      setBanner({ variant: 'error', text: errorMessage(err) })
    } finally {
      setPaying((prev) => ({ ...prev, [order.id]: false }))
    }
  }

  async function handleExpiry() {
    setExpiring(true)
    try {
      const res = await expireReservations()
      setBanner({ variant: 'success', text: `Expired ${res.expired} reservation(s)` })
      reload()
    } catch (err) {
      setBanner({ variant: 'error', text: errorMessage(err) })
    } finally {
      setExpiring(false)
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <h1 className="title">Flash Sale Orders</h1>
        <label className="customer-field">
          <span>Customer ID</span>
          <input
            id="customer-id"
            data-testid="customer-id"
            type="text"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
          />
        </label>
      </header>

      <main className="content">
        {banner && (
          <div
            role="status"
            data-testid="banner"
            data-variant={banner.variant}
            className={`banner banner-${banner.variant}`}
          >
            {banner.text}
          </div>
        )}

        <section className="panel">
          <div className="panel-header">
            <h2>Products</h2>
          </div>
          <ProductsTable
            products={products}
            loading={productsLoading}
            error={productsError}
            reserving={reserving}
            onReserve={handleReserve}
          />
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Your orders</h2>
            <div className="actions">
              <button
                type="button"
                className="btn"
                data-testid="run-expiry"
                disabled={expiring}
                onClick={handleExpiry}
              >
                Run expiry
              </button>
              <button type="button" className="btn" data-testid="refresh" onClick={reload}>
                Refresh
              </button>
            </div>
          </div>
          {cid ? (
            <OrdersTable
              orders={orders}
              productNames={productNames}
              loading={ordersLoading}
              error={ordersError}
              paying={paying}
              onPay={handlePay}
            />
          ) : (
            <p className="muted panel-body">Enter a customer ID to see orders.</p>
          )}
        </section>
      </main>
    </div>
  )
}
