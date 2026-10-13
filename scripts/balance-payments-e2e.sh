#!/usr/bin/env bash
#
# End-to-end test of balance payments from the sales CRMs (the user,
# 2026-10-13): a part-paid enrolment's next payment, recorded in the CRM with
# its receipt, approved or rejected here, and read back with its status.
#
# Stands up a throwaway mongod (random port, never 27017) and a throwaway
# finance API, neither reading a .env (bun --no-env-file). Nothing leaves this
# machine: no mail transport, no Tetra Commission, no LMS.
#
#   ./scripts/balance-payments-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/balance-payments-e2e.XXXXXX")"
LONG="$(printf 'x%.0s' {1..40})"
INBOUND_SECRET="e2e-inbound-secret-that-is-long-enough"
TC_SECRET="e2e-finance-to-commission-secret-long-enough"

free_port() {
  local p
  for _ in $(seq 1 50); do
    p=$(( $1 + RANDOM % 800 ))
    [ "$p" = "27017" ] && continue
    lsof -ti:"$p" >/dev/null 2>&1 || { echo "$p"; return 0; }
  done
  echo "No free port near $1" >&2; exit 1
}
MONGO_PORT="${E2E_MONGO_PORT:-$(free_port 27100)}"
API_PORT="${E2E_API_PORT:-$(free_port 4300)}"

release_port() {
  local port="$1" pids
  for _ in $(seq 1 20); do
    pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$pids" ] && return 0
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.25
  done
  pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
}

cleanup() {
  local code=$?
  release_port "$API_PORT"
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

echo "Starting a throwaway mongod on :$MONGO_PORT"
mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongod.log" >/dev/null

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-balance-payments-e2e"
export JWT_ACCESS_SECRET="$LONG"
export JWT_REFRESH_SECRET="$LONG"
export INBOUND_CLIENT_ID="sales-crm-e2e"
export INBOUND_INTEGRATION_SECRET="$INBOUND_SECRET"
export COMMISSION_API_URL=""
export COMMISSION_S2S_SECRET="$TC_SECRET"
export E2E_API_PORT="$API_PORT"
export API_PORT="$API_PORT"
export LMS_API_URL="" LMS_S2S_SECRET="" RESEND_API_KEY=""
export FROM_EMAIL="billing@e2e-test.com"
export NODE_ENV=development
export RUN_SCHEDULERS=false

echo "Starting the finance API on :$API_PORT (no mail transport)"
cd "$REPO/apps/api"
SMTP_HOST="" SMTP_USER="" SMTP_PASS="" bun --no-env-file src/index.ts > "$WORK/log/api.log" 2>&1 &

for _ in $(seq 1 80); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null || {
  echo "The API did not start:" >&2
  tail -30 "$WORK/log/api.log" >&2
  exit 1
}

echo "Driving balance payments"
if ! bun --no-env-file src/scripts/balance-payments-e2e.ts; then
  echo
  echo "--- last 40 lines of the API log ---" >&2
  tail -40 "$WORK/log/api.log" >&2
  exit 1
fi
