# Flash-Sale — Implementation Plan

## Stack

- Backend: Express + TypeScript (run with `tsx`), `pg`, `zod`. Port `4000` (env `PORT`).
- DB: PostgreSQL 16 via `docker-compose.yml` → `postgres://flash:flash@localhost:5433/flashsale` (env `DATABASE_URL`).
- Frontend: React + Vite + TypeScript, port `5173`, Vite proxy `/api` → `http://localhost:4000`.
- Tests: Playwright (API + UI) at repo root `e2e/`.

## Layout

```
docker-compose.yml
backend/
  src/
    config.ts              env: PORT, DATABASE_URL, RESERVATION_TTL_SECONDS (default 120), ALLOW_DEV_RESET
    db.ts                  pg Pool + withTransaction(fn) helper (BEGIN/COMMIT/ROLLBACK, always release)
    schema.sql             DDL (idempotent: CREATE TABLE IF NOT EXISTS)
    migrate.ts             runs schema.sql + seeds products (INSERT ... ON CONFLICT DO NOTHING)
    errors.ts              AppError(httpStatus, code, message) + express error middleware
    validation.ts          zod schemas
    services/
      orders.service.ts    createOrder, getOrder, listOrders
      payments.service.ts  handlePaymentEvent
      expiry.service.ts    expireReservations
      products.service.ts  listProducts, resetDemoData
    routes/
      products.routes.ts
      orders.routes.ts
      webhooks.routes.ts
      dev.routes.ts
    app.ts                 build express app (json, cors, routes, error mw)
    server.ts              migrate then listen
frontend/                  Vite React TS
e2e/                       Playwright specs
playwright.config.ts
```

Routes = HTTP + validation only. Services = SQL + business rules. No SQL in routes.

## Schema

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock       INTEGER NOT NULL CHECK (stock >= 0)          -- last line of defence
);

CREATE TABLE IF NOT EXISTS orders (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     TEXT NOT NULL,
  product_id      TEXT NOT NULL REFERENCES products(id),
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  amount_cents    INTEGER NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('reserved','confirmed','cancelled','expired')),
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS orders_reserved_expiry_idx ON orders (expires_at) WHERE status = 'reserved';

CREATE TABLE IF NOT EXISTS payment_events (
  event_id    TEXT PRIMARY KEY,                -- dedupe key from provider
  order_id    UUID NOT NULL,
  status      TEXT NOT NULL,
  outcome     TEXT NOT NULL,                   -- applied_confirmed | applied_cancelled | ignored_<state> | rejected_expired
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Seed: laptop/Laptop/100000/2, keyboard/Keyboard/10000/5, mouse/Mouse/5000/10.

## Concurrency decision

**Atomic conditional UPDATE (row lock, pessimistic at row level) — not optimistic versioning.**

```sql
UPDATE products SET stock = stock - $qty WHERE id = $pid AND stock >= $qty RETURNING price_cents
```

- Postgres takes a row lock. A second concurrent tx blocks, then (READ COMMITTED) re-evaluates the
  `WHERE` against the committed row. If stock is now insufficient → 0 rows → 409.
- No read-then-write gap, so no lost update. Correct across N backend instances because the DB is the
  arbiter. `CHECK (stock >= 0)` guarantees non-negative even if code is wrong.
- Optimistic (version column + retry) rejected: on a flash sale the product row is a hot spot →
  most attempts conflict → retry storms. Single short row lock is cheaper and deterministic.

Lock order everywhere: **order row → product row** (webhook, expiry). Creation locks only product row
then inserts a new order row. No cycles → no deadlocks.

## Task A — `POST /api/orders`

Body (zod, strict): `customer_id` string 1..100, `product_id` string 1..100, `quantity` int 1..100,
`idempotency_key` string 1..200. Also accept `Idempotency-Key` header if body key absent.
`request_hash` = sha256 of `${product_id}:${quantity}`.

Algorithm:

1. Look up `orders WHERE customer_id=$1 AND idempotency_key=$2`. If found:
   - same `request_hash` → **200** with existing order, header `Idempotent-Replayed: true`.
   - different hash → **422** `IDEMPOTENCY_KEY_REUSED`.
2. `withTransaction`:
   - conditional UPDATE above. 0 rows → `SELECT 1 FROM products WHERE id=$pid`:
     missing → **404** `PRODUCT_NOT_FOUND`; else **409** `INSUFFICIENT_STOCK`. (tx rolls back.)
   - `INSERT INTO orders (..., status='reserved', expires_at = now() + make_interval(secs => $ttl)) RETURNING *`.
   - On unique violation (`23505`, concurrent retry with same key raced past step 1): throw sentinel,
     tx ROLLBACK (stock decrement undone), then re-read existing order and apply step 1 rules.
3. **201** with order.

Failure midway → ROLLBACK → stock and order never diverge.
Insufficient-stock responses are not cached against the key (no order created); a retry re-evaluates.

## Task C — `POST /api/webhooks/payment`

Body: `event_id` string, `order_id` uuid, `status` enum `payment_succeeded|payment_failed`.

In one transaction:

1. `INSERT INTO payment_events (event_id, order_id, status, outcome) VALUES (..., 'pending')
   ON CONFLICT (event_id) DO NOTHING RETURNING event_id`. No row → duplicate delivery →
   return **200** `{ duplicate: true, order }` with current order. Nothing changes.
2. `SELECT * FROM orders WHERE id=$1 FOR UPDATE`. Missing → **404** `ORDER_NOT_FOUND` (rollback, so the
   event is not recorded and provider can retry).
3. If `status <> 'reserved'` → outcome `ignored_<status>`, no change (terminal states are final). **200**.
4. `payment_succeeded`:
   - if `expires_at <= now()` → expire it now (status `expired`, release stock), outcome `rejected_expired`
     (late payment never confirms; real system would refund). **200**.
   - else `UPDATE orders SET status='confirmed', updated_at=now() WHERE id=$1 AND status='reserved'`; outcome `applied_confirmed`.
5. `payment_failed` → `status='cancelled'` + `UPDATE products SET stock = stock + quantity`; outcome `applied_cancelled`.
6. `UPDATE payment_events SET outcome=...`. COMMIT. Response **200** `{ duplicate: false, outcome, order }`.

State machine: `reserved → confirmed | cancelled | expired`. All others terminal. Every transition SQL
includes `AND status='reserved'` as a guard.

## Task D — `POST /api/orders/expire`

One transaction:

```sql
UPDATE orders SET status='expired', updated_at=now()
WHERE id IN (
  SELECT id FROM orders WHERE status='reserved' AND expires_at <= now()
  FOR UPDATE SKIP LOCKED                        -- safe to run on many instances concurrently
)
RETURNING id, product_id, quantity;
```

Then per returned row `UPDATE products SET stock = stock + quantity WHERE id = product_id`
(sum per product first, update in sorted product id order). Response **200** `{ expired: n, order_ids: [...] }`.
Rows locked by an in-flight webhook are skipped; next run picks them up if still reserved.

TTL configurable `RESERVATION_TTL_SECONDS` (default 120) so tests can use a short TTL.

## Other endpoints

- `GET /api/products` → `[{ id, name, price_cents, stock }]` ordered by price desc.
- `GET /api/orders/:id` → order or 404 (validate uuid → 400 on bad id).
- `GET /api/orders?customer_id=x` → that customer's orders, newest first, limit 50.
- `POST /api/dev/reset` (only when `ALLOW_DEV_RESET=1`) → `TRUNCATE payment_events, orders` + reset seed stock. Used by tests.
- `GET /api/health` → `{ ok: true }`.

Order JSON shape (snake_case, as stored): `id, customer_id, product_id, quantity, amount_cents, status,
idempotency_key, expires_at, created_at, updated_at`.

Error JSON: `{ "error": { "code": "INSUFFICIENT_STOCK", "message": "..." } }`.
Codes: `VALIDATION_ERROR` 400, `PRODUCT_NOT_FOUND` 404, `ORDER_NOT_FOUND` 404, `INSUFFICIENT_STOCK` 409,
`IDEMPOTENCY_KEY_REUSED` 422, `INTERNAL` 500.

## Task E — Frontend

Single page. Minimal corporate: white/neutral-grey surfaces, one accent `#1f3a5f`, system font stack,
1px `#d9dde3` borders, 4px radius, no gradients, no emoji, no drop shadows beyond none.

- Header bar: "Flash Sale Orders" + customer id text input (default `customer_1`).
- Products table: Name, Price, Stock, Qty input (number), "Reserve" button. Button disabled + "Reserving…" while
  loading. Generates `idempotency_key` with `crypto.randomUUID()` once per click attempt.
- Inline status banner: success (order id + status) / error (message from API `error.message`).
- After order created → refetch products and orders.
- "Your orders" table: id (short), product, qty, amount, status badge, expires, actions:
  for `reserved` → "Simulate payment success", "Simulate payment failure" (POST webhook with `evt_${uuid}`).
- "Run expiry" button (calls `/api/orders/expire`) + refresh button.
- `data-testid` hooks: `product-row-<id>`, `stock-<id>`, `qty-<id>`, `reserve-<id>`, `banner`,
  `order-row-<orderId>`, `order-status-<orderId>`, `pay-success-<orderId>`, `pay-fail-<orderId>`,
  `run-expiry`, `customer-id`.

## Tests (Playwright, `e2e/`)

`playwright.config.ts` webServer: two backend instances (`PORT=4000` and `PORT=4001`, both
`ALLOW_DEV_RESET=1 RESERVATION_TTL_SECONDS=3`) + frontend on 5173. `workers: 1` (shared DB).

API specs (`request` fixture, reset in `beforeEach`):
1. create order → 201, reserved, stock decremented.
2. unknown product → 404; qty > stock → 409; bad body → 400.
3. idempotent replay → same order id, 200, stock decremented once; same key different body → 422.
4. same key sent concurrently ×5 → exactly one order, stock decremented once.
5. 1 unit left, 2 concurrent requests on **different instances** (4000 & 4001) → one 201, one 409, stock 0.
6. 20 concurrent laptop requests split across instances → exactly 2 succeed, stock 0.
7. webhook success → confirmed; same event again → duplicate, unchanged; conflicting fail event → still confirmed, stock unchanged.
8. webhook fail → cancelled, stock restored; later success event → still cancelled.
9. 5 concurrent distinct fail events for same order → stock restored exactly once.
10. expiry: create, wait > TTL, `/api/orders/expire` → expired, stock restored; late success webhook → stays expired.
11. late success webhook before sweeper ran → rejected_expired, status expired, stock restored.

UI spec: load page, products visible; reserve keyboard → banner success, stock 5→4, order row reserved;
simulate success → confirmed; reserve laptop qty 3 → error banner.

## Known limitations (for write-up)

- Webhook authenticity not verified (real: HMAC signature from provider).
- Expiry triggered manually / no scheduler (real: cron or pg_cron calling the same SQL).
- Single-product orders; no payment amount check against order.
- Insufficient-stock responses not stored against idempotency key.
- Late payment on expired order only flagged `rejected_expired`; refund flow out of scope.
- Hot-row contention caps throughput per SKU; at extreme scale shard stock into buckets or queue reservations.
