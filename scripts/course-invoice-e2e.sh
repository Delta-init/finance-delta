#!/usr/bin/env bash
#
# End-to-end test of course payments from CS Portal becoming invoices
# with receipts (apps/api/src/scripts/course-invoice-e2e.ts).
#
# A throwaway mongod and a throwaway CS Portal (the CS Portal's
# real backend): finance's services run in the test itself, decide the course
# payments, and send the decisions — with the invoice — to that Tetra
# Commission, which keeps them. Nothing reads a .env; nothing touches a
# configured database.
#
#   bash scripts/course-invoice-e2e.sh        (COMMISSION_BACKEND=… for another checkout)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMISSION_BACKEND="${COMMISSION_BACKEND:-$REPO/../commission portal /backend}"
MONGO_PORT="${E2E_MONGO_PORT:-27095}"
COMMISSION_PORT="${E2E_COMMISSION_PORT:-4151}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/course-invoice-e2e.XXXXXX")"
LONG="$(printf 'x%.0s' {1..40})"
DECISION_SECRET="e2e-finance-to-commission-secret-long-enough"

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
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

if [ ! -f "$COMMISSION_BACKEND/src/finance/funding.ts" ] || [ ! -d "$COMMISSION_BACKEND/node_modules" ]; then
  echo "CS Portal (with its dependencies) is not at $COMMISSION_BACKEND. Set COMMISSION_BACKEND." >&2
  exit 1
fi
for port in "$MONGO_PORT" "$COMMISSION_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "Port $port is already in use." >&2; exit 1; fi
done

mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongo.log" >/dev/null

(
  cd "$COMMISSION_BACKEND"
  PORT="$COMMISSION_PORT" MONGO_URI="mongodb://127.0.0.1:$MONGO_PORT" MONGO_DB="commission_course_invoice_e2e" \
  JWT_SECRET="$LONG" FINANCE_S2S_SECRET="$DECISION_SECRET" \
  FINANCE_API_URL="" FINANCE_CLIENT_ID="" FINANCE_INTEGRATION_SECRET="" FINANCE_ORG_ID="" \
  ROOT_ERP_API_URL="" ROOT_ERP_SECRET="" LMS_S2S_SECRET="" LMS_API_URL="" \
  SMTP_HOST="" SMTP_USER="" SMTP_PASS="" ANTHROPIC_API_KEY="" UPLOAD_DIR="$WORK/uploads" \
  bun --no-env-file src/index.ts > "$WORK/log/commission.log" 2>&1 &
)
for _ in $(seq 1 80); do curl -sf "http://127.0.0.1:$COMMISSION_PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$COMMISSION_PORT/health" >/dev/null || { tail -30 "$WORK/log/commission.log" >&2; exit 1; }

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-course-invoice-e2e"
export COMMISSION_MONGO_URI="mongodb://127.0.0.1:$MONGO_PORT"
export COMMISSION_MONGO_DB="commission_course_invoice_e2e"
export COMMISSION_API_URL="http://127.0.0.1:$COMMISSION_PORT"
export COMMISSION_S2S_SECRET="$DECISION_SECRET"
export JWT_ACCESS_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG"
export SMTP_HOST="" SMTP_USER="" SMTP_PASS="" RESEND_API_KEY="" LMS_API_URL="" LMS_S2S_SECRET=""
export NODE_ENV=development RUN_SCHEDULERS=false

cd "$REPO/apps/api"
if ! bun --no-env-file src/scripts/course-invoice-e2e.ts; then
  echo "--- last 30 lines of the CS Portal log ---" >&2
  tail -30 "$WORK/log/commission.log" >&2
  exit 1
fi
