#!/usr/bin/env bash
#
# DUBAI-STUD (2026-11-20): backfill:dubai-stud, the worker's sends to the LMS and
# CS Portal, and the Approvals mark. (The tag at the close itself is checked in
# crm-handover-e2e.sh, step G.)
#
# A throwaway mongod and the scripts themselves, neither reading a .env (bun
# --no-env-file). The LMS and CS Portal are a stand-in the check runs.
#
#   ./scripts/dubai-stud-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/dubai-stud-e2e.XXXXXX")"
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

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-dubai-stud-e2e"
export JWT_ACCESS_SECRET="$LONG"
export JWT_REFRESH_SECRET="$LONG"
# The check points the LMS and CS Portal addresses at its own stand-in before anything reads them.
export LMS_API_URL="http://127.0.0.1:9" LMS_S2S_SECRET="e2e-finance-to-lms-secret-long-enough"
export COMMISSION_API_URL="" COMMISSION_S2S_SECRET="" RESEND_API_KEY=""
export FROM_EMAIL="billing@e2e-test.com"
export NODE_ENV=development
export RUN_SCHEDULERS=false
export SMTP_HOST="" SMTP_USER="" SMTP_PASS=""
export DOTENV_CONFIG_PATH="$WORK/no-such-dotenv"

cd "$REPO/apps/api"
bun --no-env-file src/scripts/dubai-stud-e2e.ts
