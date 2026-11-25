import { createHash } from 'crypto';
import { z } from 'zod';
import { EVENT_STATUSES } from '../db/schema';

// ASSUMPTION: Only structurally invalid bodies (missing/empty eventId, type, or data.orderId,
// or non-string optional fields) are rejected with 400. Extra fields on the body or `data`
// are preserved as part of the stored jsonb payload.
export const webhookBodySchema = z
  .object({
    eventId: z.string().trim().min(1, 'eventId must be a non-empty string'),
    type: z.string().trim().min(1, 'type must be a non-empty string'),
    data: z
      .object({
        orderId: z.string().trim().min(1, 'data.orderId must be a non-empty string'),
        customerId: z.string().optional(),
        simulate: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type WebhookBody = z.infer<typeof webhookBodySchema>;

export const listEventsQuerySchema = z.object({
  status: z
    .union([z.enum(EVENT_STATUSES), z.literal('')])
    .optional()
    .transform((val) => (val === '' ? undefined : val)),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListEventsQuery = z.infer<typeof listEventsQuerySchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const entry = obj[key];
      if (entry !== undefined) {
        sorted[key] = canonicalize(entry);
      }
    }
    return sorted;
  }
  return value;
}

// ASSUMPTION: Payload equality for conflicting_payload_count compares canonical JSON
// (recursively key-sorted) via SHA-256 so semantically identical payloads with different
// key ordering do not count as payload conflicts.
export function computePayloadHash(payload: Record<string, unknown>): string {
  const canonicalJson = JSON.stringify(canonicalize(payload));
  return createHash('sha256').update(canonicalJson).digest('hex');
}
