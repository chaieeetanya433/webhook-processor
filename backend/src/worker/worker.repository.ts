import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { PG_POOL } from '../db/db.module';
import { EventStatus } from '../db/schema';

export interface ClaimedEvent {
  eventId: string;
  type: string;
  payload: Record<string, unknown>;
  status: EventStatus;
  attemptCount: number;
  attemptsInBudget: number;
}

export interface CompletionHooks {
  onBeforeCommitSuccess?: (client: PoolClient, eventId: string) => Promise<void>;
}

@Injectable()
export class WorkerRepository {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async claimNextEvent(workerId: string, leaseMs: number): Promise<ClaimedEvent | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const claimResult = await client.query<{
        event_id: string;
        type: string;
        payload: Record<string, unknown>;
        status: EventStatus;
        attempt_count: number;
        attempts_in_budget: number;
      }>(
        `WITH candidate AS (
           SELECT event_id
           FROM events
           WHERE status = 'pending' AND next_run_at <= now()
           ORDER BY next_run_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE events e
         SET
           status = 'processing',
           locked_by = $1,
           lease_expires_at = now() + ($2 * interval '1 millisecond'),
           attempt_count = e.attempt_count + 1,
           attempts_in_budget = e.attempts_in_budget + 1,
           updated_at = now()
         FROM candidate
         WHERE e.event_id = candidate.event_id
         RETURNING e.event_id, e.type, e.payload, e.status, e.attempt_count, e.attempts_in_budget`,
        [workerId, leaseMs],
      );

      if (claimResult.rowCount !== 1) {
        await client.query('COMMIT');
        return null;
      }

      const row = claimResult.rows[0];
      await client.query(
        `INSERT INTO event_attempts (event_id, attempt_number, worker_id, started_at)
         VALUES ($1, $2, $3, now())`,
        [row.event_id, row.attempt_count, workerId],
      );

      await client.query('COMMIT');

      return {
        eventId: row.event_id,
        type: row.type,
        payload: row.payload,
        status: row.status,
        attemptCount: row.attempt_count,
        attemptsInBudget: row.attempts_in_budget,
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async completeSuccess(
    params: {
      eventId: string;
      orderId: string;
      workerId: string;
      attemptNumber: number;
      warning?: string;
    },
    hooks?: CompletionHooks,
  ): Promise<{ fencedOut: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const updateEvent = await client.query(
        `UPDATE events
         SET
           status = 'succeeded',
           completed_at = now(),
           locked_by = NULL,
           lease_expires_at = NULL,
           last_error = NULL,
           updated_at = now()
         WHERE event_id = $1
           AND locked_by = $2
           AND attempt_count = $3
           AND status = 'processing'`,
        [params.eventId, params.workerId, params.attemptNumber],
      );

      if (updateEvent.rowCount !== 1) {
        await client.query('ROLLBACK');
        return { fencedOut: true };
      }

      await client.query(
        `INSERT INTO processed_orders (order_id, event_id)
         VALUES ($1, $2)
         ON CONFLICT (event_id) DO NOTHING`,
        [params.orderId, params.eventId],
      );

      await client.query(
        `UPDATE event_attempts
         SET
           finished_at = now(),
           result = 'success',
           error = $3
         WHERE event_id = $1
           AND attempt_number = $2
           AND finished_at IS NULL`,
        [params.eventId, params.attemptNumber, params.warning ?? null],
      );

      if (hooks?.onBeforeCommitSuccess) {
        await hooks.onBeforeCommitSuccess(client, params.eventId);
      }

      await client.query('COMMIT');
      return { fencedOut: false };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
}
