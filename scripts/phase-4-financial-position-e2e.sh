#!/usr/bin/env bash
#
# Phase 4 cash flow and financial position (2026-11-27): cash flow, cash
# position, receivables, obligations, advances, position
# — through the real report services.
#
# Stands up a throwaway mongod (random port, never 27017); reads no .env
# (bun --no-env-file); HRMS is stood in for. Nothing leaves this machine.
#
#   ./scripts/phase-4-financial-position-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/phase-4-e2e.XXXXXX")"

free_port() {
  local p
  for _ in $(seq 1 50); do
    p=$(( $1 + RANDOM % 800 ))
    [ "$p" = "27017" ] && continue
    lsof -ti:"$p" >/dev/null 2>&1 || { echo "$p"; return 0; }
  done
  echo "No free port near $1" >&2; exit 1
}
MONGO_PORT="${E2E_MONGO_PORT:-$(free_port 27100)}"

cleanup() {
  local code=$? pids
  pids="$(lsof -nP -t -iTCP:"$MONGO_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill $pids 2>/dev/null || true
  sleep 0.5
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

echo "Starting a throwaway mongod on :$MONGO_PORT"
mkdir -p "$WORK/db"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/mongod.log" >/dev/null

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-phase-4-e2e"
export JWT_ACCESS_SECRET="e2e-access-secret-0123456789-0123456789-abcdef"
export JWT_REFRESH_SECRET="e2e-refresh-secret-0123456789-0123456789-abcdef"
export NODE_ENV=development RUN_SCHEDULERS=false HRMS_API_URL="" LMS_API_URL="" COMMISSION_API_URL="" RESEND_API_KEY="" SMTP_HOST=""

cd "$REPO/apps/api"
bun --no-env-file src/scripts/phase-4-financial-position-e2e.ts
