import { Inject, Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';
import { computePayloadHash, WebhookBody } from './dto';

export interface IngestResult {
  eventId: string;
  status: 'accepted';
  duplicate: boolean;
}

@Injectable()
export class WebhooksService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhooksService.name);
  }

  async ingestWebhook(body: WebhookBody): Promise<IngestResult> {
    const payloadHash = computePayloadHash(body);
    const payloadJson = JSON.stringify(body);

    const insertResult = await this.pool.query<{ event_id: string }>(
      `INSERT INTO events (event_id, type, payload, payload_hash, status)
       VALUES ($1, $2, $3::jsonb, $4, 'pending')
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [body.eventId, body.type, payloadJson, payloadHash],
    );

    if (insertResult.rowCount === 1) {
      this.logger.info({ eventId: body.eventId, type: body.type }, 'Accepted new webhook event');
      return {
        eventId: body.eventId,
        status: 'accepted',
        duplicate: false,
      };
    }

    const conflictResult = await this.pool.query<{ payload_conflict: boolean }>(
      `UPDATE events
       SET
         duplicate_count = duplicate_count + 1,
         conflicting_payload_count = conflicting_payload_count + CASE WHEN payload_hash <> $2 THEN 1 ELSE 0 END,
         updated_at = now()
       WHERE event_id = $1
       RETURNING (payload_hash <> $2) AS payload_conflict`,
      [body.eventId, payloadHash],
    );

    const payloadConflict = conflictResult.rows[0]?.payload_conflict ?? false;
    if (payloadConflict) {
      this.logger.warn(
        { eventId: body.eventId, type: body.type, incomingPayloadHash: payloadHash },
        'Duplicate eventId received with conflicting payload; original payload retained',
      );
    } else {
      this.logger.info(
        { eventId: body.eventId, type: body.type },
        'Duplicate webhook event ignored',
      );
    }

    return {
      eventId: body.eventId,
      status: 'accepted',
      duplicate: true,
    };
  }
}
