# Environment & Local Setup

## Prerequisites

- **Bun** ≥ 1.3
- **Docker** (for local MongoDB replica set + Redis) — or local installs
- **MongoDB as a replica set** (required: the posting engine uses multi-document
  transactions; standalone Mongo cannot do them)

## First-time setup

```bash
bun install                       # all workspaces
cp .env.example .env              # then fill in the values below
docker compose up -d              # Mongo (RS) + Redis
bun run db:init                   # init replica set + seed chart of accounts (Phase 0+)
bun run dev                       # web (:3000) + api (:4000) + worker
```

## Environment variables

Backend (`apps/api`) reads these (parsed/validated with Zod at boot — missing required
vars fail fast):

```bash
# ── Core ──
NODE_ENV=development
API_PORT=4000
WEB_ORIGIN=http://localhost:3000          # CORS allowlist (comma-separated for many)

# ── Database ──
MONGODB_URI=mongodb://localhost:27017/delta?replicaSet=rs0

# ── Auth ──
JWT_ACCESS_SECRET=change-me-32-bytes-min
JWT_REFRESH_SECRET=change-me-different-32-bytes
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL=30d
COOKIE_DOMAIN=localhost

# ── Cloudflare R2 (S3-compatible) ──
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=delta-files
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_PRESIGN_TTL_SECONDS=300

# ── Jobs / realtime scaling ──
REDIS_URL=redis://localhost:6379

# ── Email (invoice delivery, reminders) ──
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
MAIL_FROM="Delta Finance <no-reply@deltafinance.app>"

# ── FX rates (optional; manual entry works without it) ──
FX_PROVIDER_API_KEY=

# ── Deferred provider seams (leave blank until activated) ──
PAYMENT_GATEWAY_KEY=        # Stripe / Telr / Network Intl
OCR_PROVIDER_KEY=           # Textract / Google Document AI
EINVOICE_PROVIDER_KEY=      # ZATCA / GST e-invoice
```

Frontend (`apps/web`) — public vars are exposed to the browser; NextAuth secrets stay
server-side (no `NEXT_PUBLIC_` prefix):

```bash
# Public (browser)
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
NEXT_PUBLIC_SOCKET_URL=http://localhost:4000

# NextAuth (Auth.js) — server-only
AUTH_SECRET=change-me-32-bytes-min      # signs/encrypts the session cookie
AUTH_URL=http://localhost:3000          # canonical app URL (NEXTAUTH_URL in v4)
AUTH_TRUST_HOST=true                    # needed behind a proxy / in dev
API_INTERNAL_URL=http://localhost:4000/api/v1  # server→API calls from NextAuth callbacks
```

## Secrets policy

- `.env` is **gitignored**. Only `.env.example` (shape, no values) is committed.
- Production secrets come from the host's secret manager, never a file in the repo.
- See [SECURITY.md](SECURITY.md) for rotation.

## Local MongoDB replica set (why)

Transactions require a replica set. `docker-compose.yml` runs a single-node RS:

```yaml
# docker-compose.yml (sketch — created in Phase 0)
services:
  mongo:
    image: mongo:7
    command: ["--replSet", "rs0", "--bind_ip_all"]
    ports: ["27017:27017"]
    volumes: ["mongo-data:/data/db"]
  redis:
    image: redis:7
    ports: ["6379:6379"]
volumes: { mongo-data: {} }
```

`bun run db:init` runs `rs.initiate()` once and seeds a default chart of accounts.

## Useful scripts (root)

```bash
bun run dev          # web + api + worker (concurrent)
bun run build        # build all workspaces
bun run typecheck    # tsc --noEmit across workspaces
bun run lint         # eslint
bun test             # unit + integration
bun run db:init      # replica set + seed
```
