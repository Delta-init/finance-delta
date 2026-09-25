#!/usr/bin/env bash
#
# End-to-end test of a fund request from Media ERP becoming a drawdown here.
#
# Stands up a throwaway mongod and a throwaway finance API, then drives the
# whole path over real HTTP: the signed handover, the review, the refusal to
# overspend a month, and the status Media ERP polls for. Tears both down
# afterwards.
#
# Nothing here touches a configured database. The scratch mongod runs on its own
# port with its own data directory under /tmp, and the driver refuses to start
# unless MONGODB_URI names a local test database.
#
#   ./scripts/fund-request-e2e.sh
#   E2E_API_PORT=4123 ./scripts/fund-request-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${E2E_MONGO_PORT:-27092}"
API_PORT="${E2E_API_PORT:-4132}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/fund-request-e2e.XXXXXX")"

# Local and throwaway. The API validates their length, not their secrecy.
LONG="$(printf 'x%.0s' {1..40})"
INBOUND_SECRET="e2e-inbound-secret-that-is-long-enough"

# Kill whatever is listening on a port, and wait for it to actually go. `kill $!`
# alone is not enough: bun re-execs, and mongod --fork daemonises away from this
# shell entirely, so both outlive the trap and are left writing to a data
# directory that has just been deleted.
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

DB="mongodb://127.0.0.1:$MONGO_PORT/finance-fund-request-e2e"

# One environment for both the server and the driver, so the driver's fixtures
# and the server's requests cannot disagree about which database they mean.
export MONGODB_URI="$DB"
export JWT_ACCESS_SECRET="$LONG"
export JWT_REFRESH_SECRET="$LONG"
export INBOUND_CLIENT_ID="media-erp-e2e"
export INBOUND_INTEGRATION_SECRET="$INBOUND_SECRET"
export E2E_API_PORT="$API_PORT"
export API_PORT="$API_PORT"
export NODE_ENV=development
export RUN_SCHEDULERS=false

# Bun loads apps/api/.env on its own, whatever is imported — and that file can
# hold a real database, mail account and HRMS/LMS credentials. The variables
# above would win over it, but anything it sets that they do not (SMTP above
# all) would reach the scratch API and send real mail. So no .env at all: the
# scratch processes see exactly what is exported here and nothing else.
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

echo "Driving the fund requests"
if ! $BUN src/scripts/fund-request-e2e.ts; then
  echo
  echo "--- last 40 lines of the API log ---" >&2
  tail -40 "$WORK/log/api.log" >&2
  exit 1
fi
