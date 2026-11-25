#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
PG_USER="${POSTGRES_USER:-webhook}"
PG_DB="${POSTGRES_DB:-webhook_processor}"
RUN_ID="$(date +%s)-$$"
EVENT_ID="demo-perm-fail-${RUN_ID}"
ORDER_ID="ord-perm-fail-${RUN_ID}"
DO_MANUAL_RETRY="${1:-}"

echo "=== Scenario: Permanent Failure (and optional Manual Retry) ==="
echo "Expectation: always_fail exhausts MAX_ATTEMPTS and transitions to failed_permanent."

curl -sf -X POST "${API_URL}/webhooks" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\":\"${EVENT_ID}\",\"type\":\"order.created\",\"data\":{\"orderId\":\"${ORDER_ID}\",\"simulate\":\"always_fail\"}}"
echo ""

echo "Polling until ${EVENT_ID} reaches failed_permanent..."
for _ in $(seq 1 180); do
  BODY=$(curl -s "${API_URL}/events/${EVENT_ID}")
  if echo "${BODY}" | grep -q '"status":"failed_permanent"'; then
    break
  fi
  sleep 1
done

echo "--- SQL Verification (Permanent Failure) ---"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT event_id, status, attempt_count, attempts_in_budget, last_error FROM events WHERE event_id = '${EVENT_ID}';"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT attempt_number, worker_id, result, error FROM event_attempts WHERE event_id = '${EVENT_ID}' ORDER BY attempt_number;"

if [ "${DO_MANUAL_RETRY}" = "--retry" ]; then
  echo "Triggering manual retry via POST /events/${EVENT_ID}/retry..."
  curl -sf -X POST "${API_URL}/events/${EVENT_ID}/retry"
  echo ""
  for _ in $(seq 1 180); do
    BODY=$(curl -s "${API_URL}/events/${EVENT_ID}")
    if echo "${BODY}" | grep -q '"status":"failed_permanent"'; then
      break
    fi
    sleep 1
  done
  docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
    "SELECT attempt_number, worker_id, result FROM event_attempts WHERE event_id = '${EVENT_ID}' ORDER BY attempt_number;"
fi
