#!/usr/bin/env bash
#
# Manual payroll — months entered or imported in finance by an organization not run through HRMS
# (apps/api/src/scripts/payroll-manual-e2e.ts): finance's services in the test itself, HRMS stood in for in-process
# and asserted never called for the manual organization. Nothing reads a .env; nothing touches a configured database.
#
#   bash scripts/payroll-manual-e2e.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${E2E_MONGO_PORT:-27163}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/payroll-manual-e2e.XXXXXX")"
LONG="$(printf 'x%.0s' {1..40})"

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
cleanup() { local code=$?; release_port "$MONGO_PORT"; rm -rf "$WORK"; exit $code; }
trap cleanup EXIT INT TERM
if lsof -nP -iTCP:"$MONGO_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $MONGO_PORT is already in use." >&2; exit 1; fi

mkdir -p "$WORK/db"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/mongo.log" >/dev/null

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-payroll-manual-e2e"
export JWT_ACCESS_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG"
# HRMS is never reached: not configured here, and every client call is stood in for by the test.
export HRMS_API_URL="" HRMS_CLIENT_ID="" HRMS_INTEGRATION_SECRET=""
export SMTP_HOST="" SMTP_USER="" SMTP_PASS="" RESEND_API_KEY="" LMS_API_URL="" LMS_S2S_SECRET="" COMMISSION_API_URL="" COMMISSION_S2S_SECRET=""
export ROOT_ERP_API_URL="" NODE_ENV=development RUN_SCHEDULERS=false

cd "$REPO/apps/api"
bun --no-env-file src/scripts/payroll-manual-e2e.ts
