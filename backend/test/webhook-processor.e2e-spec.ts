import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { ApiModule } from '../src/api.module';
import { APP_CONFIG, PG_POOL } from '../src/db/db.module';
import { AppConfig, loadConfig } from '../src/config/env';
import {
  createTestWorker,
  pollUntil,
  resetDatabase,
  runTestMigrations,
  TEST_DATABASE_URL,
} from './helpers/test-db';

describe('Reliable Webhook Processor (integration & concurrency)', () => {
  let app: INestApplication;
  let pool: Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_DATABASE_URL;
    process.env.LOG_LEVEL = 'silent';

    const testConfig: AppConfig = loadConfig({
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '25',
    });

    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule],
    })
      .overrideProvider(APP_CONFIG)
      .useValue(testConfig)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    pool = app.get<Pool>(PG_POOL);
    await runTestMigrations(pool);
  });

  beforeEach(async () => {
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await app.close();
  });

  it('1. handles 50 simultaneous duplicate submissions with original payload preserved and 1 processed order', async () => {
    const eventId = 'evt_dup_50';
    const originalBody = {
      eventId,
      type: 'order.created',
      data: { orderId: 'ord_original', customerId: 'cust_1', simulate: 'ok' },
    };
    const conflictingBody = {
      eventId,
      type: 'order.created',
      data: { orderId: 'ord_conflicting', customerId: 'cust_2', simulate: 'ok' },
    };

    const requests = Array.from({ length: 50 }, (_, idx) =>
      request(app.getHttpServer())
        .post('/webhooks')
        .send(idx < 40 ? originalBody : conflictingBody),
    );

    const responses = await Promise.all(requests);
    expect(responses.every((r) => r.status === 202)).toBe(true);
    const nonDuplicates = responses.filter((r) => r.body.duplicate === false);
    const duplicates = responses.filter((r) => r.body.duplicate === true);
    expect(nonDuplicates).toHaveLength(1);
    expect(duplicates).toHaveLength(49);

    const eventRow = await pool.query<{
      payload: { data: { orderId: string } };
      duplicate_count: number;
      conflicting_payload_count: number;
    }>(
      'SELECT payload, duplicate_count, conflicting_payload_count FROM events WHERE event_id = $1',
      [eventId],
    );
    expect(eventRow.rowCount).toBe(1);
    expect(eventRow.rows[0].payload.data.orderId).toBe('ord_original');
    expect(eventRow.rows[0].duplicate_count).toBe(49);
    expect(eventRow.rows[0].conflicting_payload_count).toBe(10);

    const worker = createTestWorker(pool, { WORKER_ID: 'dup-worker' });
    worker.runner.start();
    try {
      await pollUntil(async () => {
        const res = await pool.query<{ status: string }>(
          'SELECT status FROM events WHERE event_id = $1',
          [eventId],
        );
        return res.rows[0]?.status === 'succeeded';
      });
    } finally {
      await worker.runner.stop();
    }

    const orders = await pool.query<{ order_id: string }>(
      'SELECT order_id FROM processed_orders WHERE event_id = $1',
      [eventId],
    );
    expect(orders.rowCount).toBe(1);
    expect(orders.rows[0].order_id).toBe('ord_original');
  });

  it('2. processes N events across 3 concurrent workers with strict mutual exclusion and no duplicates', async () => {
    const total = 30;
    await Promise.all(
      Array.from({ length: total }, (_, idx) =>
        request(app.getHttpServer())
          .post('/webhooks')
          .send({
            eventId: `evt_parallel_${idx}`,
            type: 'order.created',
            data: { orderId: `ord_${idx}`, simulate: 'slow:0.05' },
          })
          .expect(202),
      ),
    );

    const workers = [
      createTestWorker(pool, { WORKER_ID: 'worker-a', WORKER_CONCURRENCY: 4 }),
      createTestWorker(pool, { WORKER_ID: 'worker-b', WORKER_CONCURRENCY: 4 }),
      createTestWorker(pool, { WORKER_ID: 'worker-c', WORKER_CONCURRENCY: 4 }),
    ];
    workers.forEach((w) => w.runner.start());

    try {
      await pollUntil(async () => {
        const res = await pool.query<{ cnt: string }>(
          "SELECT count(*)::text AS cnt FROM events WHERE status = 'succeeded'",
        );
        return Number(res.rows[0].cnt) === total;
      });
    } finally {
      await Promise.all(workers.map((w) => w.runner.stop()));
    }

    const ordersCount = await pool.query<{ cnt: string }>(
      'SELECT count(*)::text AS cnt FROM processed_orders',
    );
    expect(Number(ordersCount.rows[0].cnt)).toBe(total);

    const attemptsPerEvent = await pool.query<{ event_id: string; cnt: string }>(
      "SELECT event_id, count(*)::text AS cnt FROM event_attempts WHERE result = 'success' GROUP BY event_id",
    );
    expect(attemptsPerEvent.rowCount).toBe(total);
    expect(attemptsPerEvent.rows.every((r) => Number(r.cnt) === 1)).toBe(true);

    const distinctWorkers = await pool.query<{ worker_id: string }>(
      'SELECT DISTINCT worker_id FROM event_attempts',
    );
    expect(distinctWorkers.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('3. retries temporary failures with backoff and stops permanently at MAX_ATTEMPTS', async () => {
    await request(app.getHttpServer())
      .post('/webhooks')
      .send({
        eventId: 'evt_always_fail',
        type: 'order.created',
        data: { orderId: 'ord_fail', simulate: 'always_fail' },
      })
      .expect(202);

    await request(app.getHttpServer())
      .post('/webhooks')
      .send({
        eventId: 'evt_fail_twice',
        type: 'order.created',
        data: { orderId: 'ord_recover', simulate: 'fail_then_succeed:2' },
      })
      .expect(202);

    const maxAttempts = 4;
    const backoffBaseMs = 100;
    const backoffMaxMs = 500;
    const worker = createTestWorker(pool, {
      WORKER_ID: 'retry-worker',
      MAX_ATTEMPTS: maxAttempts,
      BACKOFF_BASE_MS: backoffBaseMs,
      BACKOFF_MAX_MS: backoffMaxMs,
    });
    worker.runner.start();

    try {
      await pollUntil(async () => {
        const res = await pool.query<{ event_id: string; status: string }>(
          "SELECT event_id, status FROM events WHERE event_id IN ('evt_always_fail', 'evt_fail_twice')",
        );
        const byId = new Map(res.rows.map((r) => [r.event_id, r.status]));
        return (
          byId.get('evt_always_fail') === 'failed_permanent' &&
          byId.get('evt_fail_twice') === 'succeeded'
        );
      });
    } finally {
      await worker.runner.stop();
    }

    const failAttempts = await pool.query<{
      attempt_number: number;
      result: string;
      started_at: Date;
      finished_at: Date;
    }>(
      'SELECT attempt_number, result, started_at, finished_at FROM event_attempts WHERE event_id = $1 ORDER BY attempt_number ASC',
      ['evt_always_fail'],
    );
    expect(failAttempts.rows.map((r) => r.attempt_number)).toEqual([1, 2, 3, 4]);
    expect(failAttempts.rows.every((r) => r.result === 'failure')).toBe(true);

    for (let i = 0; i < failAttempts.rows.length - 1; i++) {
      const cap = Math.min(backoffMaxMs, backoffBaseMs * 2 ** i);
      const expectedMinGapMs = Math.floor(cap / 2) - 15; // small timer jitter tolerance
      const gapMs =
        failAttempts.rows[i + 1].started_at.getTime() - failAttempts.rows[i].finished_at.getTime();
      expect(gapMs).toBeGreaterThanOrEqual(expectedMinGapMs);
    }

    const recoverAttempts = await pool.query<{ attempt_number: number; result: string }>(
      'SELECT attempt_number, result FROM event_attempts WHERE event_id = $1 ORDER BY attempt_number ASC',
      ['evt_fail_twice'],
    );
    expect(recoverAttempts.rows).toEqual([
      { attempt_number: 1, result: 'failure' },
      { attempt_number: 2, result: 'failure' },
      { attempt_number: 3, result: 'success' },
    ]);

    const orders = await pool.query<{ event_id: string }>('SELECT event_id FROM processed_orders');
    expect(orders.rows).toEqual([{ event_id: 'evt_fail_twice' }]);
  });

  it('4a. recovers abandoned lease after worker crash and completes once', async () => {
    await request(app.getHttpServer())
      .post('/webhooks')
      .send({
        eventId: 'evt_crash_reap',
        type: 'order.created',
        data: { orderId: 'ord_crash', simulate: 'ok' },
      })
      .expect(202);

    // Simulate Worker A claiming and crashing before completion/heartbeat.
    const workerA = createTestWorker(pool, { WORKER_ID: 'worker-a', LEASE_MS: 200 });
    const claimed = await workerA.repository.claimNextEvent('worker-a', 200);
    expect(claimed?.attemptCount).toBe(1);

    const workerB = createTestWorker(pool, {
      WORKER_ID: 'worker-b',
      LEASE_MS: 1000,
      HEARTBEAT_MS: 250,
      BACKOFF_BASE_MS: 40,
      BACKOFF_MAX_MS: 100,
    });
    workerB.runner.start();
    try {
      await pollUntil(async () => {
        const res = await pool.query<{ status: string }>(
          'SELECT status FROM events WHERE event_id = $1',
          ['evt_crash_reap'],
        );
        return res.rows[0]?.status === 'succeeded';
      });
    } finally {
      await workerB.runner.stop();
    }

    const attempts = await pool.query<{
      attempt_number: number;
      worker_id: string;
      result: string;
    }>(
      'SELECT attempt_number, worker_id, result FROM event_attempts WHERE event_id = $1 ORDER BY attempt_number ASC',
      ['evt_crash_reap'],
    );
    expect(attempts.rows).toEqual([
      { attempt_number: 1, worker_id: 'worker-a', result: 'abandoned' },
      { attempt_number: 2, worker_id: 'worker-b', result: 'success' },
    ]);

    const orders = await pool.query<{ cnt: string }>(
      'SELECT count(*)::text AS cnt FROM processed_orders WHERE event_id = $1',
      ['evt_crash_reap'],
    );
    expect(Number(orders.rows[0].cnt)).toBe(1);
  });

  it('4b. rolls back business insert if worker crashes before commit and fences stale completion', async () => {
    await request(app.getHttpServer())
      .post('/webhooks')
      .send({
        eventId: 'evt_crash_tx',
        type: 'order.created',
        data: { orderId: 'ord_tx', simulate: 'ok' },
      })
      .expect(202);

    const workerA = createTestWorker(pool, { WORKER_ID: 'worker-a', LEASE_MS: 150 });
    const claimed = await workerA.repository.claimNextEvent('worker-a', 150);
    expect(claimed).not.toBeNull();

    // Crash after INSERT INTO processed_orders but before COMMIT -> tx rolls back cleanly.
    await expect(
      workerA.repository.completeSuccess(
        {
          eventId: 'evt_crash_tx',
          orderId: 'ord_tx',
          workerId: 'worker-a',
          attemptNumber: claimed!.attemptCount,
        },
        {
          onBeforeCommitSuccess: async () => {
            throw new Error('Simulated crash before commit');
          },
        },
      ),
    ).rejects.toThrow('Simulated crash before commit');

    const ordersAfterCrash = await pool.query<{ cnt: string }>(
      'SELECT count(*)::text AS cnt FROM processed_orders WHERE event_id = $1',
      ['evt_crash_tx'],
    );
    expect(Number(ordersAfterCrash.rows[0].cnt)).toBe(0);

    // Let lease expire and have Worker B reap + complete.
    const workerB = createTestWorker(pool, {
      WORKER_ID: 'worker-b',
      LEASE_MS: 1000,
      BACKOFF_BASE_MS: 40,
      BACKOFF_MAX_MS: 80,
    });
    workerB.runner.start();
    try {
      await pollUntil(async () => {
        const res = await pool.query<{ status: string }>(
          'SELECT status FROM events WHERE event_id = $1',
          ['evt_crash_tx'],
        );
        return res.rows[0]?.status === 'succeeded';
      });
    } finally {
      await workerB.runner.stop();
    }

    // Stale Worker A wakes up and tries to complete attempt 1 -> fenced out.
    const staleResult = await workerA.repository.completeSuccess({
      eventId: 'evt_crash_tx',
      orderId: 'ord_tx',
      workerId: 'worker-a',
      attemptNumber: 1,
    });
    expect(staleResult.fencedOut).toBe(true);

    const finalOrders = await pool.query<{ cnt: string }>(
      'SELECT count(*)::text AS cnt FROM processed_orders WHERE event_id = $1',
      ['evt_crash_tx'],
    );
    expect(Number(finalOrders.rows[0].cnt)).toBe(1);
  });

  it('5. supports manual retry with monotonic attempt_count, budget reset, and 409 conflict protection', async () => {
    await request(app.getHttpServer())
      .post('/webhooks')
      .send({
        eventId: 'evt_manual_retry',
        type: 'order.created',
        data: { orderId: 'ord_manual', simulate: 'fail_then_succeed:4' },
      })
      .expect(202);

    const worker = createTestWorker(pool, {
      WORKER_ID: 'manual-worker',
      MAX_ATTEMPTS: 3,
      BACKOFF_BASE_MS: 40,
      BACKOFF_MAX_MS: 80,
    });
    worker.runner.start();

    try {
      await pollUntil(async () => {
        const res = await pool.query<{ status: string }>(
          'SELECT status FROM events WHERE event_id = $1',
          ['evt_manual_retry'],
        );
        return res.rows[0]?.status === 'failed_permanent';
      });

      // Unknown event -> 404
      await request(app.getHttpServer()).post('/events/nonexistent/retry').expect(404);

      // Concurrent manual retry -> exactly one 202 and rest 409
      const retryResponses = await Promise.all(
        Array.from({ length: 5 }, () =>
          request(app.getHttpServer()).post('/events/evt_manual_retry/retry'),
        ),
      );
      expect(retryResponses.filter((r) => r.status === 202)).toHaveLength(1);
      expect(retryResponses.filter((r) => r.status === 409)).toHaveLength(4);

      // Attempt 4 fails, attempt 5 succeeds (global attempt_count continues 4 -> 5)
      await pollUntil(async () => {
        const res = await pool.query<{ status: string }>(
          'SELECT status FROM events WHERE event_id = $1',
          ['evt_manual_retry'],
        );
        return res.rows[0]?.status === 'succeeded';
      });

      // Retrying a succeeded event -> 409
      await request(app.getHttpServer()).post('/events/evt_manual_retry/retry').expect(409);
    } finally {
      await worker.runner.stop();
    }

    const attempts = await pool.query<{ attempt_number: number; result: string }>(
      'SELECT attempt_number, result FROM event_attempts WHERE event_id = $1 ORDER BY attempt_number ASC',
      ['evt_manual_retry'],
    );
    expect(attempts.rows).toEqual([
      { attempt_number: 1, result: 'failure' },
      { attempt_number: 2, result: 'failure' },
      { attempt_number: 3, result: 'failure' },
      { attempt_number: 4, result: 'failure' },
      { attempt_number: 5, result: 'success' },
    ]);
  });

  it('6. keeps slow:N events alive past LEASE_MS via heartbeat without reclamation', async () => {
    await request(app.getHttpServer())
      .post('/webhooks')
      .send({
        eventId: 'evt_slow_heartbeat',
        type: 'order.created',
        data: { orderId: 'ord_slow', simulate: 'slow:0.8' },
      })
      .expect(202);

    const workerA = createTestWorker(pool, {
      WORKER_ID: 'slow-worker-a',
      LEASE_MS: 250,
      HEARTBEAT_MS: 60,
    });
    const workerB = createTestWorker(pool, {
      WORKER_ID: 'slow-worker-b',
      LEASE_MS: 250,
      HEARTBEAT_MS: 60,
    });

    workerA.runner.start();
    workerB.runner.start();

    try {
      await pollUntil(async () => {
        const res = await pool.query<{ status: string }>(
          'SELECT status FROM events WHERE event_id = $1',
          ['evt_slow_heartbeat'],
        );
        return res.rows[0]?.status === 'succeeded';
      });
    } finally {
      await Promise.all([workerA.runner.stop(), workerB.runner.stop()]);
    }

    const attempts = await pool.query<{ attempt_number: number; result: string }>(
      'SELECT attempt_number, result FROM event_attempts WHERE event_id = $1',
      ['evt_slow_heartbeat'],
    );
    expect(attempts.rows).toHaveLength(1);
    expect(attempts.rows[0]).toEqual({ attempt_number: 1, result: 'success' });

    const orders = await pool.query<{ cnt: string }>(
      'SELECT count(*)::text AS cnt FROM processed_orders WHERE event_id = $1',
      ['evt_slow_heartbeat'],
    );
    expect(Number(orders.rows[0].cnt)).toBe(1);
  });
});
