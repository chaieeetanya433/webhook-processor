#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
PG_USER="${POSTGRES_USER:-webhook}"
PG_DB="${POSTGRES_DB:-webhook_processor}"
RUN_ID="$(date +%s)-$$"
PREFIX="demo-par-${RUN_ID}"

echo "=== Scenario: Parallel Worker Execution ==="
echo "Expectation: 8 slow:5 events processed concurrently across worker-1 and worker-2"
echo "             with overlapping started_at/finished_at timestamps."

for i in $(seq 1 8); do
  curl -sf -o /dev/null -X POST "${API_URL}/webhooks" \
    -H "Content-Type: application/json" \
    -d "{\"eventId\":\"${PREFIX}-${i}\",\"type\":\"order.created\",\"data\":{\"orderId\":\"ord-par-${RUN_ID}-${i}\",\"simulate\":\"slow:5\"}}" &
done
wait
echo "Submitted 8 events."

echo "Polling until all 8 events succeed..."
for _ in $(seq 1 90); do
  DONE_COUNT=$(docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -tAc \
    "SELECT count(*) FROM events WHERE event_id LIKE '${PREFIX}-%' AND status = 'succeeded';")
  if [ "${DONE_COUNT}" = "8" ]; then
    break
  fi
  sleep 0.5
done

echo "--- SQL Verification ---"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT event_id, worker_id, attempt_number, started_at, finished_at, result FROM event_attempts WHERE event_id LIKE '${PREFIX}-%' ORDER BY started_at;"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT worker_id, count(*) AS events_handled FROM event_attempts WHERE event_id LIKE '${PREFIX}-%' GROUP BY worker_id ORDER BY worker_id;"
