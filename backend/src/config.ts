import fs from 'fs';
import path from 'path';

// backend/.env is optional; real environment variables always take precedence over it.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name} (see backend/.env.example)`);
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`Env var ${name} must be a non-negative integer, got "${raw}"`);
  return value;
}

export const config = {
  port: int('PORT', 4000),
  databaseUrl: required('DATABASE_URL'),
  reservationTtlSeconds: int('RESERVATION_TTL_SECONDS', 120),
  allowDevReset: process.env.ALLOW_DEV_RESET === '1',
  db: {
    poolMax: int('DB_POOL_MAX', 20),
    connectTimeoutMs: int('DB_CONNECT_TIMEOUT_MS', 5000),
    statementTimeoutMs: int('DB_STATEMENT_TIMEOUT_MS', 5000),
    lockTimeoutMs: int('DB_LOCK_TIMEOUT_MS', 3000),
  },
};
