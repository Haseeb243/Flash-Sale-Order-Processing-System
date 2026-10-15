export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://flash:flash@localhost:5433/flashsale',
  reservationTtlSeconds: Number(process.env.RESERVATION_TTL_SECONDS ?? 120),
  allowDevReset: process.env.ALLOW_DEV_RESET === '1',
};
