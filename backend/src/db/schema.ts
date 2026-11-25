import { sql } from 'drizzle-orm';
import {
  bigserial,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const EVENT_STATUSES = ['pending', 'processing', 'succeeded', 'failed_permanent'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

export const ATTEMPT_RESULTS = ['success', 'failure', 'abandoned'] as const;
export type AttemptResult = (typeof ATTEMPT_RESULTS)[number];

export const events = pgTable(
  'events',
  {
    eventId: text('event_id').primaryKey(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status').$type<EventStatus>().notNull().default('pending'),
    attemptCount: integer('attempt_count').notNull().default(0),
    attemptsInBudget: integer('attempts_in_budget').notNull().default(0),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull().defaultNow(),
    lockedBy: text('locked_by'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastError: text('last_error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    duplicateCount: integer('duplicate_count').notNull().default(0),
    conflictingPayloadCount: integer('conflicting_payload_count').notNull().default(0),
  },
  (table) => [
    index('idx_events_status_next_run_at').on(table.status, table.nextRunAt),
    index('idx_events_status_lease_expires_at').on(table.status, table.leaseExpiresAt),
    check(
      'events_status_check',
      sql`${table.status} IN ('pending', 'processing', 'succeeded', 'failed_permanent')`,
    ),
  ],
);

export const processedOrders = pgTable('processed_orders', {
  orderId: text('order_id').notNull(),
  // UNIQUE(event_id) is the hard duplicate guard; order_id is intentionally NOT unique
  // because distinct webhook events may reference the same order.
  eventId: text('event_id')
    .notNull()
    .unique()
    .references(() => events.eventId),
  processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
});

export const eventAttempts = pgTable(
  'event_attempts',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    eventId: text('event_id')
      .notNull()
      .references(() => events.eventId),
    attemptNumber: integer('attempt_number').notNull(),
    workerId: text('worker_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    result: text('result').$type<AttemptResult>(),
    error: text('error'),
  },
  (table) => [
    unique('uq_event_attempts_event_attempt').on(table.eventId, table.attemptNumber),
    check(
      'event_attempts_result_check',
      sql`${table.result} IN ('success', 'failure', 'abandoned')`,
    ),
  ],
);
