#!/usr/bin/env bash
#
# End-to-end test of POST /integrations/hrms/dgo-collections (2026-11-21): HRMS's DGO Points budget asking for a
# month's eligible collections — payments received in the Dubai month, net of VAT, in the base currency.
#
# Stands up a throwaway mongod and a throwaway finance API, drives signed requests at it, tears both down after.
# Nothing reads a .env; nothing touches a configured database.
#
#   ./scripts/dgo-collections-e2e.sh
#   E2E_MONGO_PORT=27162 E2E_API_PORT=4162 ./scripts/dgo-collections-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${E2E_MONGO_PORT:-27161}"
API_PORT="${E2E_API_PORT:-4161}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dgo-collections-e2e.XXXXXX")"

# Local and throwaway. The API validates their length, not their secrecy.
LONG="$(printf 'x%.0s' {1..40})"
INBOUND_SECRET="e2e-inbound-secret-that-is-long-enough"

release_port() {
  local port="$1" pids
  for _ in $(seq 1 20); do
    pids="$(lsof -ti:"$port" 2>/dev/null || true)"
    [ -z "$pids" ] && return 0
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.25
  done
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
}

cleanup() {
  local code=$?
  release_port "$API_PORT"
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

for port in "$MONGO_PORT" "$API_PORT"; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "Port $port is already in use. Set E2E_MONGO_PORT / E2E_API_PORT." >&2
    exit 1
  fi
done

echo "Starting a throwaway mongod on :$MONGO_PORT"
mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 \
  --fork --logpath "$WORK/log/mongod.log" >/dev/null

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-dgo-collections-e2e"
export JWT_ACCESS_SECRET="$LONG"
export JWT_REFRESH_SECRET="$LONG"
export INBOUND_CLIENT_ID="hrms-e2e"
export INBOUND_INTEGRATION_SECRET="$INBOUND_SECRET"
export E2E_API_PORT="$API_PORT"
export API_PORT="$API_PORT"
export NODE_ENV=development
export RUN_SCHEDULERS=false
export SMTP_HOST="" SMTP_USER="" SMTP_PASS="" RESEND_API_KEY=""
export HRMS_API_URL="" LMS_API_URL="" LMS_S2S_SECRET="" COMMISSION_API_URL="" COMMISSION_S2S_SECRET="" ROOT_ERP_API_URL=""
export R2_ACCOUNT_ID="" R2_ACCESS_KEY_ID="" R2_SECRET_ACCESS_KEY="" R2_BUCKET_NAME="e2e" R2_PUBLIC_URL="https://files.e2e.test"

# No .env at all: the scratch processes see exactly what is exported here and nothing else.
BUN="bun --no-env-file"

echo "Starting the finance API on :$API_PORT"
cd "$REPO/apps/api"
$BUN src/index.ts > "$WORK/log/api.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null || {
  echo "The API did not start:" >&2
  tail -30 "$WORK/log/api.log" >&2
  exit 1
}

echo "Driving the DGO collections route"
if ! $BUN src/scripts/dgo-collections-e2e.ts; then
  echo
  echo "--- last 40 lines of the API log ---" >&2
  tail -40 "$WORK/log/api.log" >&2
  exit 1
fi
