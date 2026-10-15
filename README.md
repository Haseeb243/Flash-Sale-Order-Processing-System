# Flash-Sale Order Processing

Express + TypeScript, PostgreSQL 16, React (Vite), and Playwright.
The requirements checklist is in [REQUIREMENTS.md](REQUIREMENTS.md). The full design and API contract are in [PLAN.md](PLAN.md).

## Run

```bash
cp .env.example .env                       # Postgres credentials/port for docker compose
cp backend/.env.example backend/.env       # DATABASE_URL, TTL, pool timeouts (set ALLOW_DEV_RESET=1 for demo/tests)
cp frontend/.env.example frontend/.env     # API_PROXY_TARGET for the Vite dev proxy

docker compose up -d --wait                # Postgres
cd backend  && npm i && npm run dev        # API on :4000 (migrates + seeds on boot)
cd frontend && npm i && npm run dev        # UI on :5173 (proxies /api)
```

All config lives in `.env` files (git-ignored; `.env.example` files are committed). Real environment
variables override them. The backend refuses to start without `DATABASE_URL`.

Tests (start their own 2 backend instances on :4000/:4001 and the UI; the DB must be up):

```bash
npm i && npx playwright install chromium
npm run test:e2e
```

Stress / chaos test (needs two backends on :4000/:4001 started with `ALLOW_DEV_RESET=1 RESERVATION_TTL_SECONDS=3`):

```bash
cd backend && RESERVATION_TTL_SECONDS=3 npm run stress -- 3000 200   # [orders] [concurrency]
```

It runs:
- a 500-request herd on a product with 2 units;
- thousands of orders with concurrent same-key retries split across both instances;
- duplicate and conflicting webhooks timed to land on both sides of the expiry boundary, while expiry sweeps run every 100ms on both instances.

It then checks DB invariants:
- stock conservation (`initial = stock + reserved/confirmed qty`) and stock never negative;
- one order per idempotency key;
- at most one state-changing event per order;
- no confirmation after expiry;
- no pending events and no 5xx responses.

Local result (2 instances, 1 Postgres): 21,950 requests at 515 req/s and 500 concurrency. All invariants held, with 0 errors and 0 deadlocks.

## Architecture decisions

### 1. Inventory race conditions: atomic conditional UPDATE

```sql
UPDATE products SET stock = stock - $qty WHERE id = $pid AND stock >= $qty RETURNING price_cents;
```

- The check and the decrement happen in one statement. There is no read-then-write gap, so a lost update is impossible.
- Two buyers race for the last unit. Postgres row-locks the product row and the second transaction waits. Under READ COMMITTED it then re-evaluates `stock >= qty` against the committed value. It matches 0 rows and the buyer gets `409 INSUFFICIENT_STOCK`.
- `CHECK (stock >= 0)` is a schema-level guarantee that stock can never go negative.
- The database is the only arbiter, with no in-process mutex. It is therefore correct with N backend instances. The test suite runs two instances and hits both at once.

**Why not optimistic locking (version column)?** In a flash sale the product row is a hot spot. Optimistic locking would make most writers fail and retry, which causes retry storms and wasted round trips. A short row lock serializes the writers fairly and deterministically.
**Why not `SELECT … FOR UPDATE` and then UPDATE?** It gives the same guarantee with one extra round trip. The conditional UPDATE is the lock and the check in a single step.

### 2. Atomic order creation

The stock decrement and the order INSERT run in one transaction. If anything fails midway the transaction rolls back, so stock and orders never diverge.

### 3. Order idempotency

- `UNIQUE (customer_id, idempotency_key)` plus a `request_hash` of the payload.
- A retry with the same key and body gets `200`, the original order and the `Idempotent-Replayed: true` header.
- Reusing the same key with a different body gets `422 IDEMPOTENCY_KEY_REUSED`.
- Two concurrent requests with the same key can both pass the pre-check. Only one INSERT wins the unique index. The loser gets `23505` and its transaction rolls back, which undoes its stock decrement. It then returns the winner's order. Stock is decremented exactly once.

### 4. Webhook idempotency and the state machine

- The `payment_events.event_id` primary key works as an inbox. `INSERT … ON CONFLICT DO NOTHING` detects duplicate deliveries without any race.
- The order is locked with `SELECT … FOR UPDATE`. Every transition is guarded with `WHERE status = 'reserved'`.
- `reserved → confirmed | cancelled | expired`. All three are terminal. A conflicting late event is recorded as `ignored_<state>` and changes nothing.
- Inventory is released only on the `reserved → cancelled/expired` transition, so it can never be released twice.
- The event row and the state change commit together. An event for an unknown order is rolled back, not recorded, so the provider can retry it later.

### 5. Expiration

- `POST /api/orders/expire` selects reserved orders past `expires_at` with `FOR UPDATE SKIP LOCKED`. It marks them `expired` and returns their stock in the same transaction.
- It is safe to run from many instances at once. Rows a webhook is currently handling are skipped and picked up on the next run.
- A late `payment_succeeded` webhook on an order past `expires_at` never confirms it, even if the sweeper has not run yet. The order is expired on the spot and the event is recorded as `rejected_expired`. A real system would trigger a refund here.

### 6. Lock ordering

Locks are always taken in the order *order row → product row*. Order creation locks only the product row. With no lock cycles there are no deadlocks.

### 7. Layering

`routes/` handle HTTP and zod validation. `services/` hold the business rules and SQL. `db.ts` holds the pool and the transaction helper.

## Limitations

- Webhook authenticity is not verified. Production would check an HMAC signature from the provider.
- Expiry is triggered manually. Production would call the same SQL from cron or pg_cron.
- Each order covers one product, and the paid amount is not reconciled against the order.
- Failed (409) attempts are not stored against the idempotency key, so a retry re-evaluates stock.
- Hot-row contention caps throughput per SKU. At extreme scale, stock could be split into buckets or reservations queued.
- `/api/dev/reset` exists for tests only and is enabled only with `ALLOW_DEV_RESET=1`.
- A success event for an already cancelled or expired order is recorded (`ignored_cancelled` / `rejected_expired`) but not refunded. A reconciliation job would read `payment_events` for this.
- A redelivered `event_id` with a different `order_id` or `status` is treated as a duplicate and not flagged.
- Auth is assumed: `customer_id` is trusted from the request, `GET /api/orders` is not scoped to a session, `/api/orders/expire` is open and CORS allows any origin.
- DB waits are bounded (pool connect 5s, `statement_timeout` 5s, `lock_timeout` 3s). A timeout returns `503 BUSY` with `Retry-After`, and the client retries with the same idempotency key.
