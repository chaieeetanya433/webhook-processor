import path from 'path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { pino } from 'pino';
import { PinoLogger } from 'nestjs-pino';
import { AppConfig } from '../../src/config/env';
import { WorkerRepository } from '../../src/worker/worker.repository';
import { WorkerRunner } from '../../src/worker/worker.runner';

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://webhook:webhook@localhost:5432/webhook_processor';

export async function runTestMigrations(pool: Pool): Promise<void> {
  const db = drizzle(pool);
  const migrationsFolder = path.resolve(__dirname, '../../drizzle');
  await migrate(db, { migrationsFolder });
}

export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query(
    'TRUNCATE TABLE processed_orders, event_attempts, events RESTART IDENTITY CASCADE',
  );
}

export async function pollUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 15000,
  intervalMs = 40,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

export function createSilentPinoLogger(): PinoLogger {
  const logger = new PinoLogger({
    pinoHttp: {
      logger: pino({ level: 'silent' }),
    },
  });
  return logger;
}

export function createTestWorker(
  pool: Pool,
  overrides: Partial<AppConfig> = {},
): {
  config: AppConfig;
  repository: WorkerRepository;
  runner: WorkerRunner;
} {
  const config: AppConfig = {
    DATABASE_URL: TEST_DATABASE_URL,
    PG_POOL_MAX: 10,
    PORT: 3001,
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    WORKER_ID: 'test-worker-1',
    WORKER_CONCURRENCY: 4,
    POLL_INTERVAL_MS: 30,
    LEASE_MS: 1500,
    HEARTBEAT_MS: 300,
    MAX_ATTEMPTS: 5,
    BACKOFF_BASE_MS: 80,
    BACKOFF_MAX_MS: 400,
    SHUTDOWN_TIMEOUT_MS: 5000,
    ...overrides,
  };

  const repository = new WorkerRepository(pool);
  const runner = new WorkerRunner(config, repository, createSilentPinoLogger());
  return { config, repository, runner };
}
