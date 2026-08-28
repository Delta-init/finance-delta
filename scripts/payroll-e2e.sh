#!/usr/bin/env bash
#
# End-to-end test of the HRMS ↔ finance payroll handover.
#
# Stands up a throwaway mongod, seeds a month in HRMS, starts the HRMS API, and
# drives the whole flow from the finance side over the signed HTTP the two
# systems really use: mapping, import, commission, adjustments, approval,
# payment, reversal. Tears everything down afterwards.
#
# Nothing here touches a configured database. The scratch mongod runs on its own
# port with its own data directory under /tmp, and both scripts refuse to start
# unless MONGODB_URI names a local test database.
#
#   ./scripts/payroll-e2e.sh
#   HRMS_REPO=/path/to/hrms ./scripts/payroll-e2e.sh
#
set -euo pipefail

FINANCE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HRMS_REPO="${HRMS_REPO:-$(cd "$FINANCE_REPO/../hrms" 2>/dev/null && pwd || echo "")}"
MONGO_PORT="${E2E_MONGO_PORT:-27077}"
HRMS_PORT="${E2E_HRMS_PORT:-5099}"
MONTH="${E2E_MONTH:-2026-03}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/payroll-e2e.XXXXXX")"

SECRET="e2e-integration-secret-that-is-long-enough"
LONG="$(printf 'x%.0s' {1..40})"

if [ -z "$HRMS_REPO" ] || [ ! -d "$HRMS_REPO/hrms-backend" ]; then
  echo "Cannot find the HRMS repo. Set HRMS_REPO=/path/to/hrms" >&2
  exit 1
fi

# Kill whatever is listening on a port, and wait for it to actually go.
# `kill $!` alone was not enough: bun re-execs, and mongod --fork daemonises
# away from this shell entirely, so both survived the trap and were left running
# against a data directory that had just been deleted.
release_port() {
  local port="$1"
  for _ in $(seq 1 20); do
    local pids
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
  release_port "$HRMS_PORT"
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  # Only once nothing is still writing to it.
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

for port in "$MONGO_PORT" "$HRMS_PORT"; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "Port $port is already in use. Set E2E_MONGO_PORT / E2E_HRMS_PORT." >&2
    exit 1
  fi
done

echo "Starting a throwaway mongod on :$MONGO_PORT"
mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 \
  --fork --logpath "$WORK/log/mongod.log" >/dev/null

HRMS_DB="mongodb://127.0.0.1:$MONGO_PORT/hrms-e2e"
FIN_DB="mongodb://127.0.0.1:$MONGO_PORT/finance-e2e"

hrms_env() {
  MONGODB_URI="$HRMS_DB" JWT_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG" \
  SUPER_ADMIN_EMAIL="e2e@example.com" SUPER_ADMIN_PASSWORD="e2ePassword1" \
  CLIENT_URL="http://localhost:3000" NODE_ENV=development \
  INTEGRATION_CLIENT_ID="delta-finance" INTEGRATION_SECRET="$SECRET" "$@"
}

echo "Seeding HRMS and submitting $MONTH"
cd "$HRMS_REPO/hrms-backend"
SEED="$(E2E_MONTH="$MONTH" hrms_env bun src/seeds/e2eSeed.ts | tail -1)"

echo "Starting the HRMS API on :$HRMS_PORT"
PORT="$HRMS_PORT" hrms_env bun src/index.ts > "$WORK/log/hrms.log" 2>&1 &
HRMS_PID=$!

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$HRMS_PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$HRMS_PORT/api/v1/health" >/dev/null || {
  echo "HRMS did not start:" >&2; tail -20 "$WORK/log/hrms.log" >&2; exit 1
}

echo "Driving the handover from finance"
cd "$FINANCE_REPO/apps/api"
MONGODB_URI="$FIN_DB" \
JWT_ACCESS_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG" \
HRMS_API_URL="http://127.0.0.1:$HRMS_PORT" \
HRMS_CLIENT_ID="delta-finance" HRMS_INTEGRATION_SECRET="$SECRET" \
E2E_HRMS_SEED="$SEED" \
  bun src/scripts/payroll-e2e.ts
