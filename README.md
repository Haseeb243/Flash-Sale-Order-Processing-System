# Flash-Sale Order Processing

Express + TypeScript, PostgreSQL 16, React (Vite), and Playwright.
The requirements checklist is in [REQUIREMENTS.md](REQUIREMENTS.md). The full design and API contract are in [PLAN.md](PLAN.md).

## Run

```bash
docker compose up -d --wait                         # Postgres on :5433
cd backend  && npm i && ALLOW_DEV_RESET=1 npm run dev   # API on :4000 (migrates + seeds on boot)
cd frontend && npm i && npm run dev                 # UI on :5173 (proxies /api)
```

Tests (start their own 2 backend instances on :4000/:4001 and the UI; the DB must be up):

```bash
npm i && npx playwright install chromium
npm run test:e2e
```

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
