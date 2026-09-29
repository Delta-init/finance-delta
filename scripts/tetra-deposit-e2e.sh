#!/usr/bin/env bash
#
# End-to-end test of Tetra Commission deposit requests approved here.
#
# Stands up a throwaway mongod, a throwaway Tetra Commission (the commission
# portal's real backend) and a throwaway finance API, pointed at each other the
# way production is: Tetra Commission sends each new deposit to finance's
# signed intake, and finance sends the accountant's decision back. The test
# drives both over HTTP, and sits a gate in front of Tetra Commission so it can
# take it down mid-approval.
#
# Nothing here touches a configured database: one mongod on its own port and
# data directory under /tmp, databases named *e2e*, and no process reads a
# .env (bun --no-env-file; neither app loads dotenv itself).
#
#   ./scripts/tetra-deposit-e2e.sh
#
# Tetra Commission is expected beside this repository at "../commission portal /backend"
# (the folder name ends in a space), with its dependencies installed; point
# COMMISSION_BACKEND somewhere else to use another copy.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMISSION_BACKEND="${COMMISSION_BACKEND:-$REPO/../commission portal /backend}"
MONGO_PORT="${E2E_MONGO_PORT:-27093}"
API_PORT="${E2E_API_PORT:-4147}"
COMMISSION_PORT="${E2E_COMMISSION_PORT:-4148}"
GATE_PORT="${E2E_GATE_PORT:-4149}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/tetra-deposit-e2e.XXXXXX")"
LONG="$(printf 'x%.0s' {1..40})"
DECISION_SECRET="e2e-finance-to-commission-secret-long-enough"
INBOUND_SECRET="e2e-inbound-secret-that-is-long-enough"
ORG_ID="64b0000000000000000000e2"

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
  release_port "$API_PORT"
  release_port "$COMMISSION_PORT"
  release_port "$GATE_PORT"
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

if [ ! -f "$COMMISSION_BACKEND/src/finance/funding.ts" ]; then
  echo "Tetra Commission (with its deposit approvals) is not at $COMMISSION_BACKEND. Set COMMISSION_BACKEND." >&2
  exit 1
fi
if [ ! -d "$COMMISSION_BACKEND/node_modules" ]; then
  echo "Tetra Commission's dependencies are not installed at $COMMISSION_BACKEND (npm ci there)," >&2
  echo "or point COMMISSION_BACKEND at a copy that has them." >&2
  exit 1
fi

for port in "$MONGO_PORT" "$API_PORT" "$COMMISSION_PORT" "$GATE_PORT"; do
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
  MONGO_DB="commission_tetra_deposit_e2e" \
  JWT_SECRET="$LONG" \
  FINANCE_S2S_SECRET="$DECISION_SECRET" \
  FINANCE_API_URL="http://127.0.0.1:$API_PORT" \
  FINANCE_CLIENT_ID="tetra-commission-e2e" \
  FINANCE_INTEGRATION_SECRET="$INBOUND_SECRET" \
  FINANCE_ORG_ID="$ORG_ID" \
  ROOT_ERP_API_URL="" ROOT_ERP_SECRET="" LMS_S2S_SECRET="" \
  SMTP_HOST="" SMTP_USER="" SMTP_PASS="" ANTHROPIC_API_KEY="" \
  UPLOAD_DIR="$WORK/uploads" \
  bun --no-env-file src/index.ts > "$WORK/log/commission.log" 2>&1 &
)

# One environment for the finance API and the driver, so they agree about
# which database and which Tetra Commission they mean. Finance reaches Tetra
# Commission through the test's gate, which can play dead.
export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-tetra-deposit-e2e"
export COMMISSION_MONGO_URI="mongodb://127.0.0.1:$MONGO_PORT"
export COMMISSION_MONGO_DB="commission_tetra_deposit_e2e"
export COMMISSION_URL="http://127.0.0.1:$COMMISSION_PORT"
export COMMISSION_API_URL="http://127.0.0.1:$GATE_PORT"
export COMMISSION_S2S_SECRET="$DECISION_SECRET"
export E2E_GATE_PORT="$GATE_PORT"
export E2E_API_PORT="$API_PORT"
export API_PORT="$API_PORT"
export E2E_ORG_ID="$ORG_ID"
export INBOUND_CLIENT_ID="tetra-commission-e2e"
export INBOUND_INTEGRATION_SECRET="$INBOUND_SECRET"
export JWT_ACCESS_SECRET="$LONG"
export JWT_REFRESH_SECRET="$LONG"
export SMTP_HOST="" SMTP_USER="" SMTP_PASS="" RESEND_API_KEY="" LMS_API_URL="" LMS_S2S_SECRET=""
export NODE_ENV=development
# The retry worker is driven by the test itself, so it runs exactly when asked.
export RUN_SCHEDULERS=false

echo "Starting the finance API on :$API_PORT"
cd "$REPO/apps/api"
bun --no-env-file src/index.ts > "$WORK/log/api.log" 2>&1 &

for url in "http://127.0.0.1:$COMMISSION_PORT/health" "http://127.0.0.1:$API_PORT/health"; do
  for _ in $(seq 1 80); do
    curl -sf "$url" >/dev/null 2>&1 && break
    sleep 0.25
  done
  curl -sf "$url" >/dev/null || {
    echo "$url did not come up:" >&2
    tail -30 "$WORK/log/commission.log" "$WORK/log/api.log" >&2
    exit 1
  }
done

echo "Driving deposits both ways"
if ! bun --no-env-file src/scripts/tetra-deposit-e2e.ts; then
  echo
  echo "--- last 30 lines of the Tetra Commission log ---" >&2
  tail -30 "$WORK/log/commission.log" >&2
  echo "--- last 30 lines of the finance API log ---" >&2
  tail -30 "$WORK/log/api.log" >&2
  exit 1
fi
