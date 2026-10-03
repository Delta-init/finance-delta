#!/usr/bin/env bash
#
# End-to-end test of POST /api/v1/lms/customer-check — the Delta LMS asking
# whether finance knows a student's email before an admin approves them.
#
# Stands up a throwaway mongod and two finance APIs: one with the LMS secret,
# one without (which must answer "not configured", never answer anyway).
# Nothing here reads a .env — the API's points at production — so both run
# with `bun --no-env-file` and everything they need set below.
#
#   ./scripts/lms-customer-check-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${E2E_MONGO_PORT:-27094}"
API_PORT="${E2E_API_PORT:-4139}"
BARE_PORT="${E2E_BARE_API_PORT:-4140}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lms-customer-check-e2e.XXXXXX")"
LONG="$(printf 'x%.0s' {1..40})"

release_port() {
  local port="$1" pids
  for _ in $(seq 1 20); do
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    [ -z "$pids" ] && return 0
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.25
  done
}

cleanup() {
  local code=$?
  release_port "$API_PORT"
  release_port "$BARE_PORT"
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

for port in "$MONGO_PORT" "$API_PORT" "$BARE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Set E2E_MONGO_PORT / E2E_API_PORT / E2E_BARE_API_PORT." >&2
    exit 1
  fi
done

echo "Starting a throwaway mongod on :$MONGO_PORT"
mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongod.log" >/dev/null

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-lms-check-e2e"
export JWT_ACCESS_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG"
export NODE_ENV=development RUN_SCHEDULERS=false
export E2E_API_PORT="$API_PORT" E2E_BARE_API_PORT="$BARE_PORT"
export E2E_LMS_SECRET="lms-customer-check-e2e-secret-0123456789"
BUN="bun --no-env-file"

cd "$REPO/apps/api"
echo "Starting the finance API on :$API_PORT, and one with no LMS secret on :$BARE_PORT"
API_PORT="$API_PORT" LMS_S2S_SECRET="$E2E_LMS_SECRET" $BUN src/index.ts > "$WORK/log/api.log" 2>&1 &
API_PORT="$BARE_PORT" LMS_S2S_SECRET="" $BUN src/index.ts > "$WORK/log/bare.log" 2>&1 &

for port in "$API_PORT" "$BARE_PORT"; do
  for _ in $(seq 1 60); do
    curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1 && break
    sleep 0.25
  done
  curl -sf "http://127.0.0.1:$port/health" >/dev/null || {
    echo "The API on :$port did not start:" >&2
    tail -30 "$WORK/log/api.log" "$WORK/log/bare.log" >&2
    exit 1
  }
done

echo "Asking about students"
if ! $BUN src/scripts/lms-customer-check-e2e.ts; then
  echo
  echo "--- last 30 lines of the API log ---" >&2
  tail -30 "$WORK/log/api.log" >&2
  exit 1
fi
