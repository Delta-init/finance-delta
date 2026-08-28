#!/usr/bin/env bash
#
# Stands up both applications on a throwaway database, loaded with a payroll
# month part-way through the handover, and leaves them running to look at.
#
# Deliberately not your configured databases. The HRMS .env points at
# production, and a preview you can click around in should not be able to write
# to real employee records. Everything here lives in a scratch mongod on its own
# port and is thrown away on exit.
#
#   ./scripts/payroll-demo.sh          # Ctrl-C to stop everything
#
set -euo pipefail

FINANCE_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HRMS_REPO="${HRMS_REPO:-$(cd "$FINANCE_REPO/../hrms" 2>/dev/null && pwd || echo "")}"

MONGO_PORT="${DEMO_MONGO_PORT:-27078}"
HRMS_API_PORT="${DEMO_HRMS_API_PORT:-5098}"
HRMS_WEB_PORT="${DEMO_HRMS_WEB_PORT:-3011}"
FIN_API_PORT="${DEMO_FIN_API_PORT:-4098}"
FIN_WEB_PORT="${DEMO_FIN_WEB_PORT:-3012}"
MONTH="${DEMO_MONTH:-2026-03}"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/payroll-demo.XXXXXX")"
SECRET="demo-integration-secret-that-is-long-enough"
LONG="$(printf 'd%.0s' {1..40})"
PASSWORD="Password123!"

[ -d "${HRMS_REPO:-}/hrms-backend" ] || { echo "Set HRMS_REPO=/path/to/hrms" >&2; exit 1; }

release_port() {
  for _ in $(seq 1 20); do
    local pids; pids="$(lsof -ti:"$1" 2>/dev/null || true)"
    [ -z "$pids" ] && return 0
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true; sleep 0.25
  done
}

cleanup() {
  echo ""
  echo "Shutting down…"
  for p in "$FIN_WEB_PORT" "$FIN_API_PORT" "$HRMS_WEB_PORT" "$HRMS_API_PORT"; do release_port "$p"; done
  mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --shutdown >/dev/null 2>&1 || true
  release_port "$MONGO_PORT"
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

for port in "$MONGO_PORT" "$HRMS_API_PORT" "$HRMS_WEB_PORT" "$FIN_API_PORT" "$FIN_WEB_PORT"; do
  lsof -ti:"$port" >/dev/null 2>&1 && { echo "Port $port is in use." >&2; exit 1; }
done

mkdir -p "$WORK/db" "$WORK/log"
echo "Throwaway mongod on :$MONGO_PORT"
mongod --dbpath "$WORK/db" --port "$MONGO_PORT" --bind_ip 127.0.0.1 --fork --logpath "$WORK/log/mongod.log" >/dev/null

HRMS_DB="mongodb://127.0.0.1:$MONGO_PORT/hrms-demo-test"
FIN_DB="mongodb://127.0.0.1:$MONGO_PORT/finance-demo-test"

hrms_env() {
  MONGODB_URI="$HRMS_DB" JWT_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG" \
  SUPER_ADMIN_EMAIL="owner@demo.local" SUPER_ADMIN_PASSWORD="$PASSWORD" \
  CLIENT_URL="http://localhost:$HRMS_WEB_PORT" NODE_ENV=development \
  INTEGRATION_CLIENT_ID="delta-finance" INTEGRATION_SECRET="$SECRET" "$@"
}

echo "Seeding HRMS and submitting $MONTH"
cd "$HRMS_REPO/hrms-backend"
SEED="$(E2E_MONTH="$MONTH" E2E_HR_EMAIL="hr@demo.local" E2E_PASSWORD="$PASSWORD" hrms_env bun src/seeds/e2eSeed.ts | tail -1)"

echo "HRMS API on :$HRMS_API_PORT"
PORT="$HRMS_API_PORT" hrms_env bun src/index.ts > "$WORK/log/hrms-api.log" 2>&1 &
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$HRMS_API_PORT/api/v1/health" >/dev/null 2>&1 && break; sleep 0.25; done

echo "Loading the month into finance"
cd "$FINANCE_REPO/apps/api"
MONGODB_URI="$FIN_DB" JWT_ACCESS_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG" \
HRMS_API_URL="http://127.0.0.1:$HRMS_API_PORT" HRMS_CLIENT_ID="delta-finance" \
HRMS_INTEGRATION_SECRET="$SECRET" E2E_HRMS_SEED="$SEED" DEMO_PASSWORD="$PASSWORD" \
  bun src/scripts/payroll-demo-seed.ts

echo "Finance API on :$FIN_API_PORT"
MONGODB_URI="$FIN_DB" API_PORT="$FIN_API_PORT" JWT_ACCESS_SECRET="$LONG" JWT_REFRESH_SECRET="$LONG" \
WEB_ORIGIN="http://localhost:$FIN_WEB_PORT" HRMS_API_URL="http://127.0.0.1:$HRMS_API_PORT" \
HRMS_CLIENT_ID="delta-finance" HRMS_INTEGRATION_SECRET="$SECRET" \
  bun src/index.ts > "$WORK/log/fin-api.log" 2>&1 &
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$FIN_API_PORT/health" >/dev/null 2>&1 && break; sleep 0.25; done

echo "HRMS web on :$HRMS_WEB_PORT"
cd "$HRMS_REPO/hrms-frontend"
NEXT_PUBLIC_API_URL="http://127.0.0.1:$HRMS_API_PORT/api/v1" \
  bun run dev --port "$HRMS_WEB_PORT" > "$WORK/log/hrms-web.log" 2>&1 &

echo "Finance web on :$FIN_WEB_PORT"
cd "$FINANCE_REPO/apps/web"
AUTH_SECRET="$LONG" AUTH_URL="http://localhost:$FIN_WEB_PORT" AUTH_TRUST_HOST=true \
API_INTERNAL_URL="http://127.0.0.1:$FIN_API_PORT/api/v1" \
NEXT_PUBLIC_API_URL="http://127.0.0.1:$FIN_API_PORT/api/v1" \
  bun run dev --port "$FIN_WEB_PORT" > "$WORK/log/fin-web.log" 2>&1 &

sleep 8
cat <<EOF

──────────────────────────────────────────────────────────────
  HRMS      http://localhost:$HRMS_WEB_PORT      hr@demo.local / $PASSWORD
  Finance   http://localhost:$FIN_WEB_PORT      accounts@demo.local / $PASSWORD

  HRMS   → Payroll, month $MONTH (submitted and locked)
  Finance → Payroll, and Payroll Mapping

  Logs in $WORK/log — Ctrl-C to stop everything.
──────────────────────────────────────────────────────────────
EOF
wait
