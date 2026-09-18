#!/usr/bin/env bash
#
# End-to-end test of how this application sends mail.
#
# Stands up a throwaway mongod, a throwaway API and a throwaway SMTP server,
# then checks the three ways this system used to lie about mail: an invoice
# that said "Sent" whether or not anything left, a reminder that chased a
# customer who had already paid, and a placeholder sender address that failed
# invisibly per-email instead of once at boot. Mail is really spoken over a
# socket and captured, so the transport is exercised rather than mocked.
#
# Nothing here touches a configured database. The scratch mongod runs on its own
# port with its own data directory under /tmp, and the driver refuses to start
# unless MONGODB_URI names a local test database.
#
#   ./scripts/mail-e2e.sh
#   E2E_API_PORT=4123 ./scripts/mail-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${E2E_MONGO_PORT:-27084}"
API_PORT="${E2E_API_PORT:-4115}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/mail-e2e.XXXXXX")"

# Local and throwaway. The API validates their length, not their secrecy.
LONG="$(printf 'x%.0s' {1..40})"
INBOUND_SECRET="e2e-inbound-secret-that-is-long-enough"

# Kill whatever is listening on a port, and wait for it to actually go. `kill $!`
# alone is not enough: bun re-execs, and mongod --fork daemonises away from this
# shell entirely, so both outlive the trap and are left writing to a data
# directory that has just been deleted.
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
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

for port in "$MONGO_PORT" "$API_PORT"; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "Port $port is already in use. Set E2E_MONGO_PORT / E2E_API_PORT." >&2
    exit 1
  fi
done

echo "Starting a throwaway mongod on :$MONGO_PORT"
mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 \
  --fork --logpath "$WORK/log/mongod.log" >/dev/null

DB="mongodb://127.0.0.1:$MONGO_PORT/finance-e2e"

# One environment for both the server and the driver, so the driver's fixtures
# and the server's requests cannot disagree about which database they mean.
export MONGODB_URI="$DB"
export JWT_ACCESS_SECRET="$LONG"
export JWT_REFRESH_SECRET="$LONG"
export INBOUND_CLIENT_ID="crm-e2e"
export INBOUND_INTEGRATION_SECRET="$INBOUND_SECRET"
export E2E_API_PORT="$API_PORT"
export API_PORT="$API_PORT"
export NODE_ENV=development
# A real sender address, or the new boot guard refuses to start — which is
# itself one of the things under test, checked separately below.
export SMTP_HOST=127.0.0.1
export SMTP_PORT="${E2E_SMTP_PORT:-2526}"
export SMTP_USER=e2e
export SMTP_PASS=e2e
export SMTP_SECURE=false
export FROM_EMAIL=billing@e2e-test.com
export FROM_NAME="Delta Finance"
export E2E_SMTP_PORT="${E2E_SMTP_PORT:-2526}"

echo "Starting the finance API on :$API_PORT"
cd "$REPO/apps/api"
bun src/index.ts > "$WORK/log/api.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null || {
  echo "The API did not start:" >&2
  tail -30 "$WORK/log/api.log" >&2
  exit 1
}

echo "Sending mail"
if ! bun src/scripts/mail-e2e.ts; then
  echo
  echo "--- last 40 lines of the API log ---" >&2
  tail -40 "$WORK/log/api.log" >&2
  exit 1
fi
