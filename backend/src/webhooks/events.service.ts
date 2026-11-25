import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { AttemptResult, EventStatus } from '../db/schema';
import { ListEventsQuery } from './dto';

export interface EventSummary {
  eventId: string;
  type: string;
  status: EventStatus;
  attemptCount: number;
  attemptsInBudget: number;
  lastError: string | null;
  lockedBy: string | null;
  nextRunAt: string;
  receivedAt: string;
  updatedAt: string;
  completedAt: string | null;
  duplicateCount: number;
  conflictingPayloadCount: number;
}

export interface EventDetail extends EventSummary {
  payload: Record<string, unknown>;
}

export interface EventAttemptItem {
  id: number;
  eventId: string;
  attemptNumber: number;
  workerId: string;
  startedAt: string;
  finishedAt: string | null;
  result: AttemptResult | null;
  error: string | null;
}

export interface ProcessedOrderItem {
  orderId: string;
  eventId: string;
  processedAt: string;
}

export interface EventsListResponse {
  items: EventSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface EventDetailResponse {
  event: EventDetail;
  attempts: EventAttemptItem[];
  processedOrder: ProcessedOrderItem | null;
}

export interface StatsResponse {
  countsByStatus: Record<EventStatus, number>;
  totalEvents: number;
  processedOrdersCount: number;
}

@Injectable()
export class EventsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EventsService.name);
  }

  async listEvents(query: ListEventsQuery): Promise<EventsListResponse> {
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    if (query.status) {
      params.push(query.status);
      whereClauses.push(`status = $${params.length}`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const limitParam = params.length + 1;
    const offsetParam = params.length + 2;

    const [rowsResult, countResult] = await Promise.all([
      this.pool.query<{
        event_id: string;
        type: string;
        status: EventStatus;
        attempt_count: number;
        attempts_in_budget: number;
        last_error: string | null;
        locked_by: string | null;
        next_run_at: Date;
        received_at: Date;
        updated_at: Date;
        completed_at: Date | null;
        duplicate_count: number;
        conflicting_payload_count: number;
      }>(
        `SELECT
           event_id,
           type,
           status,
           attempt_count,
           attempts_in_budget,
           last_error,
           locked_by,
           next_run_at,
           received_at,
           updated_at,
           completed_at,
           duplicate_count,
           conflicting_payload_count
         FROM events
         ${whereSql}
         ORDER BY received_at DESC, event_id DESC
         LIMIT $${limitParam} OFFSET $${offsetParam}`,
        [...params, query.limit, query.offset],
      ),
      this.pool.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM events ${whereSql}`,
        params,
      ),
    ]);

    return {
      items: rowsResult.rows.map((row) => ({
        eventId: row.event_id,
        type: row.type,
        status: row.status,
        attemptCount: row.attempt_count,
        attemptsInBudget: row.attempts_in_budget,
        lastError: row.last_error,
        lockedBy: row.locked_by,
        nextRunAt: row.next_run_at.toISOString(),
        receivedAt: row.received_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        completedAt: row.completed_at ? row.completed_at.toISOString() : null,
        duplicateCount: row.duplicate_count,
        conflictingPayloadCount: row.conflicting_payload_count,
      })),
      total: Number(countResult.rows[0]?.total ?? 0),
      limit: query.limit,
      offset: query.offset,
    };
  }

  async getEventDetail(eventId: string): Promise<EventDetailResponse> {
    const eventRes = await this.pool.query<{
      event_id: string;
      type: string;
      payload: Record<string, unknown>;
      status: EventStatus;
      attempt_count: number;
      attempts_in_budget: number;
      last_error: string | null;
      locked_by: string | null;
      next_run_at: Date;
      received_at: Date;
      updated_at: Date;
      completed_at: Date | null;
      duplicate_count: number;
      conflicting_payload_count: number;
    }>(
      `SELECT
         event_id,
         type,
         payload,
         status,
         attempt_count,
         attempts_in_budget,
         last_error,
         locked_by,
         next_run_at,
         received_at,
         updated_at,
         completed_at,
         duplicate_count,
         conflicting_payload_count
       FROM events
       WHERE event_id = $1`,
      [eventId],
    );

    if (eventRes.rowCount !== 1) {
      throw new NotFoundException(`Event '${eventId}' not found`);
    }

    const row = eventRes.rows[0];
    const [attemptsRes, processedRes] = await Promise.all([
      this.pool.query<{
        id: string;
        event_id: string;
        attempt_number: number;
        worker_id: string;
        started_at: Date;
        finished_at: Date | null;
        result: AttemptResult | null;
        error: string | null;
      }>(
        `SELECT id::text, event_id, attempt_number, worker_id, started_at, finished_at, result, error
         FROM event_attempts
         WHERE event_id = $1
         ORDER BY attempt_number ASC`,
        [eventId],
      ),
      this.pool.query<{
        order_id: string;
        event_id: string;
        processed_at: Date;
      }>(
        `SELECT order_id, event_id, processed_at
         FROM processed_orders
         WHERE event_id = $1`,
        [eventId],
      ),
    ]);

    return {
      event: {
        eventId: row.event_id,
        type: row.type,
        payload: row.payload,
        status: row.status,
        attemptCount: row.attempt_count,
        attemptsInBudget: row.attempts_in_budget,
        lastError: row.last_error,
        lockedBy: row.locked_by,
        nextRunAt: row.next_run_at.toISOString(),
        receivedAt: row.received_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        completedAt: row.completed_at ? row.completed_at.toISOString() : null,
        duplicateCount: row.duplicate_count,
        conflictingPayloadCount: row.conflicting_payload_count,
      },
      attempts: attemptsRes.rows.map((a) => ({
        id: Number(a.id),
        eventId: a.event_id,
        attemptNumber: a.attempt_number,
        workerId: a.worker_id,
        startedAt: a.started_at.toISOString(),
        finishedAt: a.finished_at ? a.finished_at.toISOString() : null,
        result: a.result,
        error: a.error,
      })),
      processedOrder: processedRes.rows[0]
        ? {
            orderId: processedRes.rows[0].order_id,
            eventId: processedRes.rows[0].event_id,
            processedAt: processedRes.rows[0].processed_at.toISOString(),
          }
        : null,
    };
  }

  async retryEvent(eventId: string): Promise<{ eventId: string; status: 'pending' }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const locked = await client.query<{ event_id: string; status: EventStatus }>(
        `SELECT event_id, status
         FROM events
         WHERE event_id = $1
         FOR UPDATE`,
        [eventId],
      );

      if (locked.rowCount !== 1) {
        await client.query('ROLLBACK');
        throw new NotFoundException(`Event '${eventId}' not found`);
      }

      const currentStatus = locked.rows[0].status;
      if (currentStatus !== 'failed_permanent') {
        await client.query('ROLLBACK');
        throw new ConflictException(
          `Cannot retry event '${eventId}' in status '${currentStatus}'; only 'failed_permanent' events can be retried`,
        );
      }

      await client.query(
        `UPDATE events
         SET
           status = 'pending',
           attempts_in_budget = 0,
           next_run_at = now(),
           completed_at = NULL,
           locked_by = NULL,
           lease_expires_at = NULL,
           updated_at = now()
         WHERE event_id = $1`,
        [eventId],
      );

      await client.query('COMMIT');
      this.logger.info({ eventId }, 'Manually scheduled failed_permanent event for retry');

      return { eventId, status: 'pending' };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async getStats(): Promise<StatsResponse> {
    const [statusRes, ordersRes] = await Promise.all([
      this.pool.query<{ status: EventStatus; cnt: string }>(
        `SELECT status, count(*)::text AS cnt
         FROM events
         GROUP BY status`,
      ),
      this.pool.query<{ cnt: string }>(`SELECT count(*)::text AS cnt FROM processed_orders`),
    ]);

    const countsByStatus: Record<EventStatus, number> = {
      pending: 0,
      processing: 0,
      succeeded: 0,
      failed_permanent: 0,
    };

    let totalEvents = 0;
    for (const row of statusRes.rows) {
      const count = Number(row.cnt);
      countsByStatus[row.status] = count;
      totalEvents += count;
    }

    return {
      countsByStatus,
      totalEvents,
      processedOrdersCount: Number(ordersRes.rows[0]?.cnt ?? 0),
    };
  }

  async checkHealth(): Promise<{ status: 'ok'; db: 'connected' }> {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok', db: 'connected' };
    } catch (err) {
      this.logger.error({ err }, 'Health check failed');
      throw new ServiceUnavailableException({ status: 'error', db: 'disconnected' });
    }
  }
}
