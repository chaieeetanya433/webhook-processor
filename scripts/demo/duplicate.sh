#!/usr/bin/env bash
set -euo pipefail

API_URL="${API_URL:-http://localhost:3001}"
PG_USER="${POSTGRES_USER:-webhook}"
PG_DB="${POSTGRES_DB:-webhook_processor}"
RUN_ID="$(date +%s)-$$"
EVENT_ID="demo-dup-${RUN_ID}"
ORDER_ID="ord-dup-${RUN_ID}"

echo "=== Scenario: Simultaneous Duplicate Ingestion ==="
echo "Expectation: 20 parallel POST /webhooks with eventId=${EVENT_ID} all return 202,"
echo "             only 1 event row is created (duplicate_count=19), and processed_orders has 1 row."

PAYLOAD=$(cat <<EOF
{"eventId":"${EVENT_ID}","type":"order.created","data":{"orderId":"${ORDER_ID}","simulate":"ok"}}
EOF
)

export API_URL PAYLOAD
seq 1 20 | xargs -P 20 -I{} sh -c '
  code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${API_URL}/webhooks" \
    -H "Content-Type: application/json" \
    -d "${PAYLOAD}")
  echo "Request #{}: HTTP ${code}"
'

echo "Waiting for event ${EVENT_ID} to reach succeeded..."
for _ in $(seq 1 60); do
  BODY=$(curl -s "${API_URL}/events/${EVENT_ID}")
  if echo "${BODY}" | grep -q '"status":"succeeded"'; then
    break
  fi
  sleep 0.5
done

echo "--- SQL Verification ---"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT event_id, status, attempt_count, duplicate_count, conflicting_payload_count FROM events WHERE event_id = '${EVENT_ID}';"
docker compose exec -T postgres psql -U "${PG_USER}" -d "${PG_DB}" -c \
  "SELECT count(*) AS processed_orders_count FROM processed_orders WHERE event_id = '${EVENT_ID}';"
