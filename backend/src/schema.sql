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
  refund_required BOOLEAN NOT NULL DEFAULT false, -- payment captured but order not confirmed by it
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE payment_events ADD COLUMN IF NOT EXISTS refund_required BOOLEAN NOT NULL DEFAULT false;
