#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
PG_USER="${POSTGRES_USER:-webhook}"
PG_DB="${POSTGRES_DB:-webhook_processor}"
RUN_ID="$(date +%s)-$$"
EVENT_ID="demo-crash-${RUN_ID}"
ORDER_ID="ord-crash-${RUN_ID}"

echo "=== Scenario: Worker Crash (SIGKILL) & Lease Reaper Recovery ==="
echo "Expectation: Submit slow:30, kill the claiming worker container, wait for lease expiry,"
echo "             surviving worker marks attempt 1 'abandoned' and completes attempt 2."

curl -sf -X POST "${API_URL}/webhooks" \
  -H "Content-Type: application/json" \
  -d "{\"eventId\":\"${EVENT_ID}\",\"type\":\"order.created\",\"data\":{\"orderId\":\"${ORDER_ID}\",\"simulate\":\"slow:30\"}}"
echo ""

LOCKED_BY=""
echo "Polling GET /events/${EVENT_ID} until lockedBy is set..."
for _ in $(seq 1 60); do
  BODY=$(curl -s "${API_URL}/events/${EVENT_ID}")
  LOCKED_BY=$(echo "${BODY}" | sed -n 's/.*"lockedBy":"\([^"]*\)".*/\1/p')
  if [ -n "${LOCKED_BY}" ]; then
    break
  fi
  sleep 0.25
done

if [ -z "${LOCKED_BY}" ]; then
  echo "Timed out waiting for a worker to claim ${EVENT_ID}"
  exit 1
fi

CONTAINER_NAME="webhook-${LOCKED_BY}"
echo "Event claimed by ${LOCKED_BY}. Killing container ${CONTAINER_NAME}..."
docker kill "${CONTAINER_NAME}"

echo "Waiting for lease expiry, reaper takeover, and slow:30 completion..."
for _ in $(seq 1 180); do
  BODY=$(curl -s "${API_URL}/events/${EVENT_ID}")
  if echo "${BODY}" | grep -q '"status":"succeeded"'; then
    break
  fi
  sleep 1
done

echo "--- SQL Verification ---"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT event_id, status, attempt_count, locked_by FROM events WHERE event_id = '${EVENT_ID}';"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT attempt_number, worker_id, result, error, started_at, finished_at FROM event_attempts WHERE event_id = '${EVENT_ID}' ORDER BY attempt_number;"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT count(*) AS processed_orders_count FROM processed_orders WHERE event_id = '${EVENT_ID}';"

echo "Note: Restart the killed worker afterwards with: docker compose up -d ${LOCKED_BY}"
