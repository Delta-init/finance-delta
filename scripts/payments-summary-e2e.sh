#!/usr/bin/env bash
#
# The Payments list's cards (apps/api/src/scripts/payments-summary-e2e.ts, 2026-11-20):
# finance's services in the test itself. Nothing reads a .env; nothing touches a configured database.
#
#   bash scripts/payments-summary-e2e.sh
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/payments-summary-e2e.XXXXXX")"
LONG="$(printf 'x%.0s' {1..40})"

free_port() {
  local p
  for _ in $(seq 1 50); do
    p=$(( $1 + RANDOM % 800 ))
    [ "$p" = "27017" ] && continue
    lsof -ti:"$p" >/dev/null 2>&1 || { echo "$p"; return 0; }
  done
  echo "No free port near $1" >&2; exit 1
}
MONGO_PORT="${E2E_MONGO_PORT:-$(free_port 27400)}"

cleanup() {
  local code=$?
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  local pids
  pids="$(lsof -nP -t -iTCP:"$MONGO_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

echo "Starting a throwaway mongod on :$MONGO_PORT"
mkdir -p "$WORK/db"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/mongo.log" >/dev/null

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-payments-summary-e2e"
export JWT_ACCESS_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG"
export SMTP_HOST="" SMTP_USER="" SMTP_PASS="" RESEND_API_KEY="" LMS_API_URL="" LMS_S2S_SECRET="" COMMISSION_API_URL="" COMMISSION_S2S_SECRET=""
export NODE_ENV=development RUN_SCHEDULERS=false
export DOTENV_CONFIG_PATH="$WORK/no-such-dotenv"

cd "$REPO/apps/api"
bun --no-env-file src/scripts/payments-summary-e2e.ts
