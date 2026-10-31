#!/usr/bin/env bash
#
# An approved enrolment moved to another course with its payments (apps/api/src/scripts/enrolment-change-e2e.ts):
# against a throwaway database. Nothing reads a .env; nothing touches a configured database.
#
#   bash scripts/enrolment-change-e2e.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${E2E_MONGO_PORT:-27134}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/enrolment-change-e2e.XXXXXX")"
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

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-enrolment-change-e2e"
export JWT_ACCESS_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG"
export SMTP_HOST="" SMTP_USER="" SMTP_PASS="" RESEND_API_KEY="" LMS_API_URL="" LMS_S2S_SECRET="" COMMISSION_API_URL="" COMMISSION_S2S_SECRET=""
export NODE_ENV=development RUN_SCHEDULERS=false

cd "$REPO/apps/api"
bun --no-env-file src/scripts/enrolment-change-e2e.ts
