/**
 * Stress + chaos test against two running backend instances (ALLOW_DEV_RESET=1, short TTL).
 *
 *   npx tsx scripts/stress.ts [orders=3000] [concurrency=200]
 *
 * Phase 1  thundering herd: 500 simultaneous laptop requests (stock 2).
 * Phase 2  sustained load: N logical orders, each sent 1-3 times concurrently with the same
 *          idempotency key (client retries), spread over both instances. Every created order
 *          gets 1-4 webhook events (random success/fail, each delivered 1-3x) after a random
 *          delay of 0..2xTTL, while expiry sweeps run every 100ms on both instances.
 * Set RESERVATION_TTL_SECONDS to the servers' TTL (default 3).
 * Then the DB is checked against invariants; any violation exits non-zero.
 */
import { randomUUID } from 'crypto';
import { Pool } from 'pg';

const BASES = ['http://localhost:4000', 'http://localhost:4001'];
const N = Number(process.argv[2] ?? 3000);
const CONCURRENCY = Number(process.argv[3] ?? 200);
const TTL_MS = Number(process.env.RESERVATION_TTL_SECONDS ?? 3) * 1000;
const INITIAL: Record<string, number> = { laptop: 2, keyboard: 50, mouse: 500 };

const pool = new Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://flash:flash@localhost:5433/flashsale' });
const statusCounts: Record<string, number> = {};
const latencies: number[] = [];
const failures: string[] = [];

const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function post(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const start = performance.now();
  try {
    const res = await fetch(pick(BASES) + path, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    latencies.push(performance.now() - start);
    const key = `${path.split('?')[0]} ${res.status}`;
    statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    return { status: res.status, json };
  } catch (err) {
    statusCounts[`${path} NETWORK_ERROR`] = (statusCounts[`${path} NETWORK_ERROR`] ?? 0) + 1;
    return { status: 0, json: null };
  }
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < items.length) await worker(items[i++]);
    }),
  );
}

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
}

const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))].toFixed(1);

async function main(): Promise<void> {
  await post('/api/dev/reset');
  for (const [id, stock] of Object.entries(INITIAL)) {
    await pool.query('UPDATE products SET stock = $2 WHERE id = $1', [id, stock]);
  }
  const t0 = performance.now();

  // Phase 1: thundering herd on the hot row.
  const herd = await Promise.all(
    Array.from({ length: 500 }, (_, i) =>
      post('/api/orders', { customer_id: `herd_${i}`, product_id: 'laptop', quantity: 1, idempotency_key: randomUUID() }),
    ),
  );
  const herdOk = herd.filter((r) => r.status === 201).length;
  const orderIds = new Set<string>(herd.filter((r) => r.status === 201).map((r) => r.json.id));
  check('herd: exactly 2 of 500 laptop requests succeed', herdOk === 2, `${herdOk} succeeded`);

  // Expiry sweeps run on both instances for the whole remaining test.
  let sweeping = true;
  const sweeper = (async () => {
    while (sweeping) {
      await Promise.all(BASES.map(() => post('/api/orders/expire')));
      await sleep(100);
    }
  })();

  // Webhook chaos for one order: 1-4 events (random success/fail), each delivered 1-3x,
  // after a random delay of 0..2xTTL so deliveries land on both sides of the expiry boundary.
  const webhookJobs: Promise<unknown>[] = [];
  const chaos = async (orderId: string) => {
    const events = Array.from({ length: 1 + Math.floor(Math.random() * 4) }, () => ({
      event_id: `evt_${randomUUID()}`,
      order_id: orderId,
      status: pick(['payment_succeeded', 'payment_failed']),
    }));
    await sleep(Math.random() * 2 * TTL_MS);
    await Promise.all(
      events.flatMap((e) => Array.from({ length: 1 + Math.floor(Math.random() * 3) }, () => post('/api/webhooks/payment', e))),
    );
  };
  orderIds.forEach((id) => webhookJobs.push(chaos(id)));

  // Phase 2: sustained load with concurrent same-key retries.
  const intents = Array.from({ length: N }, () => ({
    customer_id: `c_${Math.floor(Math.random() * 300)}`,
    product_id: pick(['keyboard', 'mouse', 'mouse', 'mouse', 'laptop']),
    quantity: 1 + Math.floor(Math.random() * 3),
    idempotency_key: randomUUID(),
  }));
  let idempotencyMismatch = 0;
  let succeededIntents = 0;
  await runPool(intents, async (intent) => {
    const sends = 1 + Math.floor(Math.random() * 3);
    const results = await Promise.all(Array.from({ length: sends }, () => post('/api/orders', intent)));
    const ids = new Set(results.filter((r) => r.status === 200 || r.status === 201).map((r) => r.json.id));
    if (ids.size > 1) idempotencyMismatch++;
    if (ids.size >= 1) succeededIntents++;
    ids.forEach((id) => {
      orderIds.add(id);
      webhookJobs.push(chaos(id));
    });
  });
  check('idempotency: every retried request resolved to one order id', idempotencyMismatch === 0, `${idempotencyMismatch} mismatches`);

  await Promise.all(webhookJobs);
  sweeping = false;
  await sweeper;
  await sleep(TTL_MS + 500);
  await post('/api/orders/expire');
  const elapsed = (performance.now() - t0) / 1000;

  // Invariants.
  const products = (await pool.query('SELECT id, stock FROM products')).rows as { id: string; stock: number }[];
  const held = (
    await pool.query(
      `SELECT product_id, COALESCE(SUM(quantity), 0)::int AS q FROM orders
       WHERE status IN ('reserved', 'confirmed') GROUP BY product_id`,
    )
  ).rows as { product_id: string; q: number }[];
  for (const p of products) {
    const h = held.find((r) => r.product_id === p.id)?.q ?? 0;
    check(`stock conservation ${p.id}: initial = stock + held`, INITIAL[p.id] === p.stock + h, `${INITIAL[p.id]} = ${p.stock} + ${h}`);
    check(`stock non-negative ${p.id}`, p.stock >= 0, String(p.stock));
  }

  const q1 = async (sql: string) => Number((await pool.query(sql)).rows[0].n);
  check('orders in DB = successful logical requests', (await q1('SELECT count(*) AS n FROM orders')) === succeededIntents + herdOk);
  check(
    'each order has at most one state-changing event',
    (await q1(`SELECT count(*) AS n FROM (SELECT order_id FROM payment_events
        WHERE outcome IN ('applied_confirmed','applied_cancelled','rejected_expired')
        GROUP BY order_id HAVING count(*) > 1) x`)) === 0,
  );
  check(
    'confirmed orders have exactly one applied_confirmed event',
    (await q1(`SELECT count(*) AS n FROM orders o WHERE o.status = 'confirmed' AND
        (SELECT count(*) FROM payment_events e WHERE e.order_id = o.id AND e.outcome = 'applied_confirmed') <> 1`)) === 0,
  );
  check(
    'cancelled orders have exactly one applied_cancelled event',
    (await q1(`SELECT count(*) AS n FROM orders o WHERE o.status = 'cancelled' AND
        (SELECT count(*) FROM payment_events e WHERE e.order_id = o.id AND e.outcome = 'applied_cancelled') <> 1`)) === 0,
  );
  check(
    'no order confirmed after its expiry time',
    (await q1(`SELECT count(*) AS n FROM orders o JOIN payment_events e ON e.order_id = o.id
        WHERE e.outcome = 'applied_confirmed' AND e.received_at > o.expires_at`)) === 0,
  );
  check('no event left pending', (await q1(`SELECT count(*) AS n FROM payment_events WHERE outcome = 'pending'`)) === 0);
  check('no reservation left after final sweep', (await q1(`SELECT count(*) AS n FROM orders WHERE status = 'reserved'`)) === 0);
  const errors5xx = Object.entries(statusCounts).filter(([k]) => / 5\d\d$| NETWORK_ERROR$/.test(k) && !k.endsWith(' 503'));
  check('no 500s or network errors', errors5xx.length === 0, errors5xx.map(([k, v]) => `${k}: ${v}`).join(', '));

  const statuses = (await pool.query('SELECT status, count(*)::int AS n FROM orders GROUP BY status ORDER BY status')).rows;
  latencies.sort((a, b) => a - b);
  console.log('\nHTTP responses:', statusCounts);
  console.log('Order statuses:', Object.fromEntries(statuses.map((r: any) => [r.status, r.n])));
  console.log(
    `Requests: ${latencies.length} in ${elapsed.toFixed(1)}s (${(latencies.length / elapsed).toFixed(0)} req/s), ` +
      `latency ms p50 ${pct(latencies, 50)} p95 ${pct(latencies, 95)} p99 ${pct(latencies, 99)} max ${pct(latencies, 100)}`,
  );
  console.log(failures.length ? `\n${failures.length} INVARIANT(S) VIOLATED` : '\nALL INVARIANTS HOLD');
  await pool.end();
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
