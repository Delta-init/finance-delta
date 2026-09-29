#!/usr/bin/env bash
#
# End-to-end test of the Procurement page: a purchase request HR has approved
# in HRMS is approved here as an expense — no vendor, no purchase order — and
# the answer reaches HRMS.
#
# Stands up a throwaway mongod, the real HRMS API and the real finance API, and
# drives them over the signed HTTP the two systems really use. Between finance
# and HRMS sits a small proxy the driver owns, so it can make HRMS fail half-way
# through an approval. Tears everything down afterwards.
#
# Nothing here touches a configured database or sends anything. Both APIs run
# without their .env files: Bun would load them on its own, HRMS also loads its
# own through dotenv (DOTENV_CONFIG_PATH points that at a file that does not
# exist), and both hold PRODUCTION settings. The driver refuses to start unless
# both databases are scratch e2e databases on 127.0.0.1.
#
#   ./scripts/procurement-expense-e2e.sh
#   HRMS_REPO=/path/to/hrms ./scripts/procurement-expense-e2e.sh
#
# HRMS_BUN_FLAGS adds flags to the HRMS process — e.g. --preload with a
# stand-in for a module a checkout has not installed yet.
#
set -euo pipefail

FINANCE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HRMS_REPO="${HRMS_REPO:-$(cd "$FINANCE_REPO/../hrms" 2>/dev/null && pwd || echo "")}"
MONGO_PORT="${E2E_MONGO_PORT:-27079}"
HRMS_PORT="${E2E_HRMS_PORT:-5093}"
PROXY_PORT="${E2E_PROXY_PORT:-5094}"
API_PORT="${E2E_API_PORT:-4143}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/procurement-expense-e2e.XXXXXX")"

# Local and throwaway. The APIs validate their length, not their secrecy.
LONG="$(printf 'x%.0s' {1..40})"
SECRET="e2e-integration-secret-that-is-long-enough"

if [ -z "$HRMS_REPO" ] || [ ! -d "$HRMS_REPO/hrms-backend" ]; then
  echo "Cannot find the HRMS repo. Set HRMS_REPO=/path/to/hrms" >&2
  exit 1
fi

# Kill whatever is listening on a port, and wait for it to actually go: bun
# re-execs and mongod --fork daemonises, so both outlive a plain `kill $!`.
release_port() {
  local port="$1" pids
  for _ in $(seq 1 20); do
    pids="$(lsof -ti:"$port" 2>/dev/null || true)"
    [ -z "$pids" ] && return 0
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.25
  done
  pids="$(lsof -ti:"$port" 2>/dev/null || true)"
  # shellcheck disable=SC2086
  [ -n "$pids" ] && kill -9 $pids 2>/dev/null || true
}

cleanup() {
  local code=$?
  release_port "$API_PORT"
  release_port "$HRMS_PORT"
  release_port "$PROXY_PORT"
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

for port in "$MONGO_PORT" "$HRMS_PORT" "$PROXY_PORT" "$API_PORT"; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "Port $port is already in use. Set E2E_MONGO_PORT / E2E_HRMS_PORT / E2E_PROXY_PORT / E2E_API_PORT." >&2
    exit 1
  fi
done

echo "Starting a throwaway mongod on :$MONGO_PORT"
mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 \
  --fork --logpath "$WORK/log/mongod.log" >/dev/null

HRMS_DB="mongodb://127.0.0.1:$MONGO_PORT/hrms-procurement-e2e"
FIN_DB="mongodb://127.0.0.1:$MONGO_PORT/finance-procurement-e2e"

echo "Starting the HRMS API on :$HRMS_PORT"
cd "$HRMS_REPO/hrms-backend"
# Everything HRMS could send or store with is set to nothing: WhatsApp and mail
# then log what they would have sent, which is what the driver reads.
# shellcheck disable=SC2086
DOTENV_CONFIG_PATH="$WORK/no-such-dotenv" \
MONGODB_URI="$HRMS_DB" PORT="$HRMS_PORT" NODE_ENV=development \
JWT_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG" \
SUPER_ADMIN_EMAIL="e2e@example.com" SUPER_ADMIN_PASSWORD="e2ePassword1" \
CLIENT_URL="http://localhost:3000" \
INTEGRATION_CLIENT_ID="delta-finance" INTEGRATION_SECRET="$SECRET" \
SMTP_HOST="" SMTP_USER="" SMTP_PASS="" MAIL_FROM="" \
WHATSAPP_API_BASE_URL="" WHATSAPP_API_KEY="" WHATSAPP_PHONE_NUMBER_ID="" \
VAPID_PUBLIC_KEY="" VAPID_PRIVATE_KEY="" \
R2_ACCOUNT_ID="" R2_ACCESS_KEY_ID="" R2_SECRET_ACCESS_KEY="" R2_BUCKET_NAME="" R2_PUBLIC_URL="" \
FACE_SERVICE_URL="" FACE_SERVICE_KEY="" ROOT_ERP_SECRET="" \
  bun --no-env-file ${HRMS_BUN_FLAGS:-} src/index.ts > "$WORK/log/hrms.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$HRMS_PORT/api/v1/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$HRMS_PORT/api/v1/health" >/dev/null || {
  echo "HRMS did not start:" >&2; tail -30 "$WORK/log/hrms.log" >&2; exit 1
}
if ! grep -q "MongoDB Connected: 127.0.0.1" "$WORK/log/hrms.log"; then
  echo "HRMS did not report connecting to the scratch database:" >&2
  tail -30 "$WORK/log/hrms.log" | sed -E 's#mongodb(\+srv)?://[^ ]*#<uri>#g' >&2
  exit 1
fi

echo "Starting the finance API on :$API_PORT"
cd "$FINANCE_REPO/apps/api"
export MONGODB_URI="$FIN_DB"
export JWT_ACCESS_SECRET="$LONG"
export JWT_REFRESH_SECRET="$LONG"
export INBOUND_CLIENT_ID="procurement-e2e"
export INBOUND_INTEGRATION_SECRET="$SECRET"
# Finance talks to HRMS through the driver's proxy, never directly.
export HRMS_API_URL="http://127.0.0.1:$PROXY_PORT"
export HRMS_CLIENT_ID="delta-finance"
export HRMS_INTEGRATION_SECRET="$SECRET"
export API_PORT="$API_PORT"
export NODE_ENV=development
export RUN_SCHEDULERS=false
bun --no-env-file src/index.ts > "$WORK/log/api.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null || {
  echo "The finance API did not start:" >&2; tail -30 "$WORK/log/api.log" >&2; exit 1
}

export E2E_HRMS_DB="$HRMS_DB"
export E2E_HRMS_PORT="$HRMS_PORT"
export E2E_PROXY_PORT="$PROXY_PORT"
export E2E_API_PORT="$API_PORT"
export E2E_HRMS_LOG="$WORK/log/hrms.log"

echo "Driving purchase requests through the Procurement page"
if ! bun --no-env-file src/scripts/procurement-expense-e2e.ts; then
  echo
  echo "--- last 40 lines of the finance API log ---" >&2
  tail -40 "$WORK/log/api.log" >&2
  echo "--- last 40 lines of the HRMS log ---" >&2
  tail -40 "$WORK/log/hrms.log" | sed -E 's#mongodb(\+srv)?://[^ ]*#<uri>#g' >&2
  exit 1
fi
