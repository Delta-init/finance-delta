#!/usr/bin/env bash
#
# backfill-lms-provisions.ts --invoice (2026-11-19): only the invoices named are
# touched — the course slug, the requeue — every other stuck enrolment left as
# it was; a number not found, or one two organizations share, changes nothing.
#
# A throwaway mongod and the script itself, neither reading a .env (bun
# --no-env-file). The LMS address points nowhere: nothing is ever sent.
#
#   ./scripts/backfill-lms-invoice-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/backfill-lms-invoice-e2e.XXXXXX")"
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
MONGO_PORT="${E2E_MONGO_PORT:-$(free_port 27300)}"

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
mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongod.log" >/dev/null

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-backfill-lms-invoice-e2e"
export JWT_ACCESS_SECRET="$LONG"
export JWT_REFRESH_SECRET="$LONG"
# Configured, so the script queues — at an address where nothing listens: nothing is sent.
export LMS_API_URL="http://127.0.0.1:9" LMS_S2S_SECRET="e2e-finance-to-lms-secret-long-enough"
export COMMISSION_API_URL="" COMMISSION_S2S_SECRET="" RESEND_API_KEY=""
export FROM_EMAIL="billing@e2e-test.com"
export NODE_ENV=development
export RUN_SCHEDULERS=false
export SMTP_HOST="" SMTP_USER="" SMTP_PASS=""
export DOTENV_CONFIG_PATH="$WORK/no-such-dotenv"

cd "$REPO/apps/api"
bun --no-env-file src/scripts/backfill-lms-invoice-e2e.ts
