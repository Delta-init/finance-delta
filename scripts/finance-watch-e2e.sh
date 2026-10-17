#!/usr/bin/env bash
#
# End-to-end test of GET /api/v1/service/finance-watch — the Root portal's Pending → Finance tab:
# approvals waiting (30 minutes = delayed) and entries typed with an old date.
#
# Stands up a throwaway mongod and a finance API with a Root portal secret.
# Nothing here reads a .env — the API's points at production — so it runs with
# `bun --no-env-file` and everything it needs set below. No HRMS is configured,
# so nothing is asked of one.
#
#   ./scripts/finance-watch-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${E2E_MONGO_PORT:-27097}"
API_PORT="${E2E_API_PORT:-4153}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/finance-watch-e2e.XXXXXX")"
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
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

for port in "$MONGO_PORT" "$API_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Set E2E_MONGO_PORT / E2E_API_PORT." >&2
    exit 1
  fi
done

echo "Starting a throwaway mongod on :$MONGO_PORT"
mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongod.log" >/dev/null

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-finance-watch-e2e"
export JWT_ACCESS_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG"
export NODE_ENV=development RUN_SCHEDULERS=false
export HRMS_API_URL="" HRMS_CLIENT_ID="" HRMS_INTEGRATION_SECRET=""
export SMTP_HOST="" SMTP_USER="" SMTP_PASS="" RESEND_API_KEY="" LMS_API_URL="" LMS_S2S_SECRET=""
export E2E_API_PORT="$API_PORT"
export E2E_ROOT_SECRET="finance-watch-e2e-secret-0123456789abcdef"
BUN="bun --no-env-file"

cd "$REPO/apps/api"
echo "Starting the finance API on :$API_PORT"
API_PORT="$API_PORT" ROOT_ERP_SECRET="$E2E_ROOT_SECRET" $BUN src/index.ts > "$WORK/log/api.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null || {
  echo "The API did not start:" >&2
  tail -30 "$WORK/log/api.log" >&2
  exit 1
}

echo "Asking what is waiting and what came in late"
if ! $BUN src/scripts/finance-watch-e2e.ts; then
  echo
  echo "--- last 30 lines of the API log ---" >&2
  tail -30 "$WORK/log/api.log" >&2
  exit 1
fi
