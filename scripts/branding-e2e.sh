#!/usr/bin/env bash
#
# End-to-end test of the logo — uploaded in settings, drawn on the invoice's
# PDF — and of a payment over an invoice's balance.
#
# Stands up a throwaway mongod and a throwaway finance API, and serves the test
# images from the driver itself. Tears everything down after.
#
# Nothing here touches a configured database. The scratch mongod runs on its own
# port with its own data directory under /tmp, the API is given no file storage,
# and the driver refuses to start unless MONGODB_URI names a local test database.
#
#   ./scripts/branding-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MONGO_PORT="${E2E_MONGO_PORT:-27095}"
API_PORT="${E2E_API_PORT:-4137}"
IMAGE_PORT="${E2E_IMAGE_PORT:-4138}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/branding-e2e.XXXXXX")"
LONG="$(printf 'x%.0s' {1..40})"

# Only what listens on the port: a client merely connected to it is left alone.
release_port() {
  local port="$1" pids
  for _ in $(seq 1 20); do
    pids="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    [ -z "$pids" ] && return 0
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.25
  done
}

cleanup() {
  local code=$?
  release_port "$API_PORT"
  release_port "$IMAGE_PORT"
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

for port in "$MONGO_PORT" "$API_PORT" "$IMAGE_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Port $port is already in use. Set E2E_MONGO_PORT / E2E_API_PORT / E2E_IMAGE_PORT." >&2
    exit 1
  fi
done

echo "Starting a throwaway mongod on :$MONGO_PORT"
mkdir -p "$WORK/db" "$WORK/log"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongod.log" >/dev/null

export MONGODB_URI="mongodb://127.0.0.1:$MONGO_PORT/finance-branding-e2e"
export JWT_ACCESS_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG"
export E2E_API_PORT="$API_PORT" API_PORT="$API_PORT" E2E_IMAGE_PORT="$IMAGE_PORT"
export NODE_ENV=development RUN_SCHEDULERS=false
# No file storage: the upload is tested as far as a server without it goes.
export R2_ACCOUNT_ID="" R2_ACCESS_KEY_ID="" R2_SECRET_ACCESS_KEY="" R2_PUBLIC_URL=""

# Bun loads apps/api/.env on its own, whatever is imported — and that file holds
# a real database, mail account and storage keys. So no .env at all: the
# scratch processes see exactly what is exported here and nothing else.
BUN="bun --no-env-file"

echo "Starting the finance API on :$API_PORT"
cd "$REPO/apps/api"
$BUN src/index.ts > "$WORK/log/api.log" 2>&1 &

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null || {
  echo "The API did not start:" >&2
  tail -30 "$WORK/log/api.log" >&2
  exit 1
}

echo "Driving the logo and the payment"
if ! $BUN src/scripts/branding-e2e.ts; then
  echo
  echo "--- last 40 lines of the API log ---" >&2
  tail -40 "$WORK/log/api.log" >&2
  exit 1
fi
