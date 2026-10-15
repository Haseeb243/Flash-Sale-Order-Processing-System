# Flash-Sale Order Processing — Requirements

Source: Technical Assessment (Full-Stack / Backend). 40 min, AI tools allowed.
Evaluation weight: correctness, engineering reasoning, trade-offs > feature count.

## Seed data

| product_id | Name     | Stock | Price  |
|------------|----------|-------|--------|
| laptop     | Laptop   | 2     | $1,000 |
| keyboard   | Keyboard | 5     | $100   |
| mouse      | Mouse    | 10    | $50    |

Customers identified by `customer_id` (auth assumed done).

## Task A — Order creation `POST /api/orders`

Request: `{ "customer_id", "product_id", "quantity", "idempotency_key" }`

- [x] A1 Verify product exists
- [x] A2 Check available inventory
- [x] A3 Reserve requested quantity
- [x] A4 Create order with status `reserved`
- [x] A5 Appropriate response when inventory insufficient
- [x] A6 Same customer + same idempotency key retried → no duplicate order
- [x] A7 Inventory + order stay consistent if operation fails midway (atomic)

## Task B — Concurrency

Scenario: 1 unit left, 2 simultaneous buyers.

- [x] B1 Only one reserves
- [x] B2 Other gets appropriate error
- [x] B3 Stock never negative
- [x] B4 Same unit never reserved twice
- [x] B5 Correct with multiple backend instances (no in-process locks)

## Task C — Payment webhook `POST /api/webhooks/payment`

Request: `{ "event_id", "order_id", "status": "payment_succeeded" | "payment_failed" }`

- [x] C1 Success: `reserved` → `confirmed`
- [x] C2 Failure: `reserved` → `cancelled` + release inventory
- [x] C3 Same webhook multiple times → no repeated change
- [x] C4 Duplicate / conflicting events never corrupt order state or inventory
- [x] C5 `confirmed`/`cancelled` order not modified by later conflicting events
- [x] C6 Payment provider may be simulated

## Task D — Expiration

- [x] D1 Reservation expires 2 min after creation if unpaid
- [x] D2 Identify expired reservations
- [x] D3 Set status `expired`
- [x] D4 Release reserved inventory
- [x] D5 Late payment cannot confirm an expired order
- [x] D6 Manual trigger endpoint is sufficient (no scheduler required)

## Task E — Minimal frontend (React / Next.js)

- [x] E1 Show products + available stock
- [x] E2 Customer can place order
- [x] E3 Show order status
- [x] E4 Loading, success, error states
- [x] E5 Refresh inventory after order created

## Technical constraints

- [x] T1 Stack: Express/NestJS + TypeScript, PostgreSQL, React/Next.js
- [x] T2 Inventory protected against race conditions
- [x] T3 Critical operations safe to retry
- [x] T4 Validation on backend
- [x] T5 Consistent state transitions
- [x] T6 Clear separation of responsibilities

## Deliverables (demo)

1. Order creation + reservation
2. Correct behavior under simultaneous requests
3. Payment success / failure / duplicate webhook handling
4. Reservation expiration
5. Minimal working frontend
6. Explanation of architecture decisions + remaining limitations
