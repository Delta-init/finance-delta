#!/usr/bin/env bash
#
# End-to-end test of a new LMS student going on to Tetra Commission.
#
# Stands up a throwaway mongod and a throwaway Tetra Commission process (the
# commission portal's real backend), then drives finance's own provisioning
# worker against them. The LMS is a stand-in served by the test itself — its
# half is scripts/lms-provision-e2e.sh — because this is about what happens
# once the LMS has, or has not, taken the student.
#
# Nothing here touches a configured database: one mongod on its own port and
# data directory under /tmp, databases named *e2e*, and neither process reads a
# .env (bun --no-env-file; neither app loads dotenv itself).
#
#   ./scripts/commission-student-e2e.sh
#
# Tetra Commission is expected beside this repository at "../commission portal /backend"
# (the folder name ends in a space), with its dependencies installed; point
# COMMISSION_BACKEND somewhere else to use another copy.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMISSION_BACKEND="${COMMISSION_BACKEND:-$REPO/../commission portal /backend}"
MONGO_PORT="${E2E_MONGO_PORT:-27091}"
COMMISSION_PORT="${E2E_COMMISSION_PORT:-4143}"
FAKE_LMS_PORT="${E2E_FAKE_LMS_PORT:-4144}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/commission-student-e2e.XXXXXX")"
LONG="$(printf 'x%.0s' {1..40})"
SECRET="e2e-finance-to-commission-secret-long-enough"

release_port() {
  local port="$1" pids
  for _ in $(seq 1 20); do
    pids="$(lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$pids" ] && return 0
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.25
  done
}

cleanup() {
  local code=$?
  release_port "$COMMISSION_PORT"
  release_port "$FAKE_LMS_PORT"
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

if [ ! -f "$COMMISSION_BACKEND/src/finance/students.ts" ]; then
  echo "Tetra Commission (with its finance route) is not at $COMMISSION_BACKEND. Set COMMISSION_BACKEND." >&2
  exit 1
fi
if [ ! -d "$COMMISSION_BACKEND/node_modules" ]; then
  echo "Tetra Commission's dependencies are not installed at $COMMISSION_BACKEND (npm ci there)," >&2
  echo "or point COMMISSION_BACKEND at a copy that has them." >&2
  exit 1
fi

for port in "$MONGO_PORT" "$COMMISSION_PORT" "$FAKE_LMS_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use." >&2
    exit 1
  fi
done

mkdir -p "$WORK/db" "$WORK/log"
echo "Starting a throwaway mongod on :$MONGO_PORT"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongo.log" >/dev/null

echo "Starting Tetra Commission on :$COMMISSION_PORT"
(
  cd "$COMMISSION_BACKEND"
  PORT="$COMMISSION_PORT" \
  MONGO_URI="mongodb://127.0.0.1:$MONGO_PORT" \
  MONGO_DB="commission_from_finance_e2e" \
  JWT_SECRET="$LONG" \
  FINANCE_S2S_SECRET="$SECRET" \
  ROOT_ERP_API_URL="" ROOT_ERP_SECRET="" \
  SMTP_HOST="" SMTP_USER="" SMTP_PASS="" ANTHROPIC_API_KEY="" \
  UPLOAD_DIR="$WORK/uploads" \
  bun --no-env-file src/index.ts > "$WORK/log/commission.log" 2>&1 &
)
for _ in $(seq 1 80); do
  curl -sf "http://127.0.0.1:$COMMISSION_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$COMMISSION_PORT/health" >/dev/null || {
  echo "Tetra Commission did not start:" >&2
  tail -30 "$WORK/log/commission.log" >&2
  exit 1
}

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-commission-e2e"
export COMMISSION_MONGO_URI="mongodb://127.0.0.1:$MONGO_PORT"
export COMMISSION_MONGO_DB="commission_from_finance_e2e"
export COMMISSION_API_URL="http://127.0.0.1:$COMMISSION_PORT"
export COMMISSION_S2S_SECRET="$SECRET"
export LMS_API_URL="http://127.0.0.1:$FAKE_LMS_PORT"
export LMS_S2S_SECRET="e2e-finance-to-lms-secret-long-enough"
export E2E_FAKE_LMS_PORT="$FAKE_LMS_PORT"
export JWT_ACCESS_SECRET="$LONG"
export JWT_REFRESH_SECRET="$LONG"
export SMTP_HOST="" SMTP_USER="" SMTP_PASS="" RESEND_API_KEY=""
export NODE_ENV=development
export RUN_SCHEDULERS=false

echo "Sending students"
cd "$REPO/apps/api"
if ! bun --no-env-file src/scripts/commission-student-e2e.ts; then
  echo
  echo "--- last 30 lines of the Tetra Commission log ---" >&2
  tail -30 "$WORK/log/commission.log" >&2
  exit 1
fi
