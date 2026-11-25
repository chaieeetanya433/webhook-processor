#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
PG_USER="${POSTGRES_USER:-webhook}"
PG_DB="${POSTGRES_DB:-webhook_processor}"
RUN_ID="$(date +%s)-$$"
PREFIX="demo-burst-${RUN_ID}"
TOTAL=500

echo "=== Scenario: 500-Event Concurrent Burst ==="
echo "Expectation: 500 mixed events ingested concurrently with low latency,"
echo "             and all 500 reach a terminal state (succeeded or failed_permanent)."

START_MS=$(date +%s%3N 2>/dev/null || echo $(( $(date +%s) * 1000 )))

export API_URL PREFIX RUN_ID
seq 1 "${TOTAL}" | xargs -P 32 -I{} sh -c '
  i={}
  if [ $((i % 100)) -eq 0 ]; then
    sim="always_fail"
  elif [ $((i % 10)) -eq 0 ]; then
    sim="fail_then_succeed:1"
  elif [ $((i % 5)) -eq 0 ]; then
    sim="slow:1"
  else
    sim="ok"
  fi
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${API_URL}/webhooks" \
    -H "Content-Type: application/json" \
    -d "{\"eventId\":\"${PREFIX}-${i}\",\"type\":\"order.created\",\"data\":{\"orderId\":\"ord-burst-${RUN_ID}-${i}\",\"simulate\":\"${sim}\"}}")
  if [ "${code}" != "202" ]; then
    echo "Unexpected HTTP ${code} for event ${i}" >&2
    exit 1
  fi
'

END_MS=$(date +%s%3N 2>/dev/null || echo $(( $(date +%s) * 1000 )))
echo "Ingested ${TOTAL} events in $((END_MS - START_MS))ms."

echo "Polling /stats until pending=0 and processing=0..."
for _ in $(seq 1 300); do
  STATS=$(curl -s "${API_URL}/stats")
  PENDING=$(echo "${STATS}" | sed -n 's/.*"pending":\([0-9]*\).*/\1/p')
  PROCESSING=$(echo "${STATS}" | sed -n 's/.*"processing":\([0-9]*\).*/\1/p')
  if [ "${PENDING}" = "0" ] && [ "${PROCESSING}" = "0" ]; then
    echo "Final /stats: ${STATS}"
    break
  fi
  sleep 1
done

echo "--- SQL Verification ---"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT status, count(*) FROM events WHERE event_id LIKE '${PREFIX}-%' GROUP BY status ORDER BY status;"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT count(*) AS processed_orders_count FROM processed_orders WHERE event_id LIKE '${PREFIX}-%';"
