#!/usr/bin/env bash
#
# End-to-end test of an approved enrolment becoming a student in the LMS.
#
# Stands up two throwaway mongods — one for finance, one for the LMS — a
# throwaway LMS process and a throwaway finance process, then approves
# enrolments and checks who ends up with course access. Both ends are real:
# the provisioning crosses a socket and is verified in the LMS's own database.
#
# Nothing here touches a configured database. Each mongod runs on its own port
# with its own data directory under /tmp, and both drivers refuse to start
# unless their URI names a scratch database.
#
#   ./scripts/lms-provision-e2e.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LMS_REPO="$REPO/../lms/backend"
FIN_MONGO="${E2E_FIN_MONGO_PORT:-27087}"
LMS_MONGO="${E2E_LMS_MONGO_PORT:-27088}"
API_PORT="${E2E_API_PORT:-4117}"
LMS_PORT="${E2E_LMS_PORT:-4118}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lms-provision-e2e.XXXXXX")"

LONG="$(printf 'x%.0s' {1..40})"
SECRET="e2e-finance-to-lms-secret-long-enough"

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
  release_port "$LMS_PORT"
  mongod --dbpath "$WORK/fin" --port "$FIN_MONGO" --shutdown >/dev/null 2>&1 || true
  mongod --dbpath "$WORK/lms" --port "$LMS_MONGO" --shutdown >/dev/null 2>&1 || true
  release_port "$FIN_MONGO"
  release_port "$LMS_MONGO"
  rm -rf "$WORK"
  exit $code
}
trap cleanup EXIT INT TERM

if [ ! -d "$LMS_REPO" ]; then
  echo "The LMS is not checked out beside this repository at ../lms/backend." >&2
  exit 1
fi

for port in "$FIN_MONGO" "$LMS_MONGO" "$API_PORT" "$LMS_PORT"; do
  if lsof -ti:"$port" >/dev/null 2>&1; then
    echo "Port $port is already in use." >&2
    exit 1
  fi
done

mkdir -p "$WORK/fin" "$WORK/lms" "$WORK/log"
echo "Starting two throwaway mongods on :$FIN_MONGO and :$LMS_MONGO"
mongod --dbpath "$WORK/fin" --port "$FIN_MONGO" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/fin-mongo.log" >/dev/null
mongod --dbpath "$WORK/lms" --port "$LMS_MONGO" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/lms-mongo.log" >/dev/null

FIN_DB="mongodb://127.0.0.1:$FIN_MONGO/finance-e2e"
LMS_DB="mongodb://127.0.0.1:$LMS_MONGO/lms-e2e"

# The LMS reads DATABASE_URL and nothing else. Setting MONGO_URI here looks
# right and does nothing: the process falls through to its own .env, which on a
# developer machine points at the live LMS. So the variable it actually reads is
# set, and the value is checked below before anything is started.
if ! grep -qE "^[[:space:]]*DATABASE_URL:" "$LMS_REPO/src/config/env.ts"; then
  echo "The LMS no longer reads DATABASE_URL. Check what it reads before running this." >&2
  exit 1
fi

echo "Starting the LMS on :$LMS_PORT"
(
  cd "$LMS_REPO"
  DATABASE_URL="$LMS_DB" \
  MONGO_URI="$LMS_DB" \
  MONGODB_URI="$LMS_DB" \
  PORT="$LMS_PORT" \
  NODE_ENV=development \
  JWT_SECRET="$LONG" \
  JWT_REFRESH_SECRET="$LONG" \
  FINANCE_S2S_SECRET="$SECRET" \
  CLIENT_URL="http://127.0.0.1:3000" \
  SMTP_HOST="" SMTP_USER="" SMTP_PASS="" RESEND_API_KEY="" \
  bun src/index.ts > "$WORK/log/lms.log" 2>&1 &
)

for _ in $(seq 1 80); do
  curl -sf "http://127.0.0.1:$LMS_PORT/health" >/dev/null 2>&1 && break
  curl -s "http://127.0.0.1:$LMS_PORT/" >/dev/null 2>&1 && break
  sleep 0.25
done

# Proof rather than intention: the scratch database has to be the one the LMS
# actually opened. A rig that believes it is isolated and is not is worse than
# no rig, and this one silently ran against the live LMS until it was caught.
sleep 1
if ! mongosh --quiet --port "$LMS_MONGO" lms-e2e --eval "db.getCollectionNames().length" >/dev/null 2>&1; then
  echo "Could not read the scratch LMS database." >&2
  exit 1
fi
WROTE="$(mongosh --quiet --port "$LMS_MONGO" lms-e2e --eval "db.getCollectionNames().length" 2>/dev/null || echo 0)"
if [ "${WROTE:-0}" -eq 0 ]; then
  echo "The LMS started but wrote nothing to the scratch database — it is talking to something else." >&2
  tail -20 "$WORK/log/lms.log" >&2
  exit 1
fi
echo "Confirmed: the LMS is using the scratch database ($WROTE collections)"

export MONGODB_URI="$FIN_DB"
export LMS_MONGODB_URI="$LMS_DB"
export JWT_ACCESS_SECRET="$LONG"
export JWT_REFRESH_SECRET="$LONG"
export LMS_API_URL="http://127.0.0.1:$LMS_PORT"
export LMS_S2S_SECRET="$SECRET"
export FROM_EMAIL="billing@e2e-test.com"
export E2E_API_PORT="$API_PORT"
export API_PORT="$API_PORT"
export NODE_ENV=development
# The provisioning is driven by the driver, not by the API's own timer.
export RUN_SCHEDULERS=false

echo "Starting the finance API on :$API_PORT"
cd "$REPO/apps/api"
bun src/index.ts > "$WORK/log/api.log" 2>&1 &

for _ in $(seq 1 80); do
  curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null || {
  echo "The finance API did not start:" >&2
  tail -30 "$WORK/log/api.log" >&2
  exit 1
}

echo "Provisioning enrolments"
if ! bun src/scripts/lms-provision-e2e.ts; then
  echo
  echo "--- last 40 lines of the finance log ---" >&2
  tail -40 "$WORK/log/api.log" >&2
  echo "--- last 40 lines of the LMS log ---" >&2
  tail -40 "$WORK/log/lms.log" >&2
  exit 1
fi
