#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
PG_USER="${POSTGRES_USER:-webhook}"
PG_DB="${POSTGRES_DB:-webhook_processor}"
RUN_ID="$(date +%s)-$$"
EVENT_ID="demo-temp-fail-${RUN_ID}"
ORDER_ID="ord-temp-fail-${RUN_ID}"

echo "=== Scenario: Temporary Failure & Exponential Backoff Recovery ==="
echo "Expectation: fail_then_succeed:2 fails attempts 1 & 2, then succeeds on attempt 3."

curl -sf -X POST "${API_URL}/webhooks" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\":\"${EVENT_ID}\",\"type\":\"order.created\",\"data\":{\"orderId\":\"${ORDER_ID}\",\"simulate\":\"fail_then_succeed:2\"}}"
echo ""

echo "Polling until ${EVENT_ID} succeeds..."
for _ in $(seq 1 120); do
  BODY=$(curl -s "${API_URL}/events/${EVENT_ID}")
  if echo "${BODY}" | grep -q '"status":"succeeded"'; then
    break
  fi
  sleep 0.5
done

echo "--- SQL Verification ---"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT event_id, status, attempt_count, attempts_in_budget FROM events WHERE event_id = '${EVENT_ID}';"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT attempt_number, worker_id, result, error, started_at, finished_at FROM event_attempts WHERE event_id = '${EVENT_ID}' ORDER BY attempt_number;"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT count(*) AS processed_orders_count FROM processed_orders WHERE event_id = '${EVENT_ID}';"
