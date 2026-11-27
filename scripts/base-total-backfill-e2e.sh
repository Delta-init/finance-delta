#!/usr/bin/env bash
#
# End-to-end test of the stored-total correction (2026-11-27): invoices whose
# stored total in the organization's currency fell behind an edit, put right
# by apps/api/src/scripts/base-total-backfill.ts.
#
# Stands up a throwaway mongod (random port, never 27017); reads no .env
# (bun --no-env-file). Nothing leaves this machine.
#
#   ./scripts/base-total-backfill-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/base-total-backfill-e2e.XXXXXX")"

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

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-base-total-e2e"
export JWT_ACCESS_SECRET="e2e-access-secret-0123456789-0123456789-abcdef"
export JWT_REFRESH_SECRET="e2e-refresh-secret-0123456789-0123456789-abcdef"
export NODE_ENV=development RUN_SCHEDULERS=false

cd "$REPO/apps/api"
bun --no-env-file src/scripts/base-total-backfill-e2e.ts
