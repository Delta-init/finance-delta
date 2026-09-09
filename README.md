# Delta Finance

> Internal Business Management System — a Zoho Books–parity platform for quotations,
> invoicing, payables, expenses, banking, inventory, payroll, projects, and full
> financial reporting.

Delta Finance is a multi-tenant (organization-scoped) accounting and operations platform
built for speed, correctness, and a premium feel. It targets UAE/India tax compliance
(VAT, GST, TDS, WPS) with multi-currency support out of the box.

---

## Tech stack

| Layer        | Choice                                                        |
| ------------ | ------------------------------------------------------------- |
| Frontend     | Next.js (App Router, React, TypeScript)                       |
| Backend      | Bun + Express + TypeScript                                    |
| Database     | MongoDB (Mongoose ODM)                                        |
| File storage | Cloudflare R2 (S3-compatible, presigned uploads)             |
| Realtime     | Socket.IO (notifications, live dashboards, document inbox)    |
| Animation    | Framer Motion (purposeful micro-interactions only)           |
| UI           | shadcn/ui primitives + custom Delta design system            |
| Data/forms   | TanStack Query (React Query), React Hook Form + Zod, Zustand  |
| Validation   | Zod (shared schemas across web + api)                         |
| Auth         | NextAuth (Auth.js) session + Express JWT/refresh + 2FA, RBAC  |

See [docs/TECH_STACK.md](docs/TECH_STACK.md) for the reasoning behind each choice.

---

## Monorepo layout

```
delta-finance/
├── apps/
│   ├── web/          # Next.js frontend
│   └── api/          # Bun + Express backend
├── packages/
│   ├── shared/       # Zod schemas, TS types, constants, money/tax utils
│   ├── ui/           # Design-system React components (the Delta DS)
│   └── config/       # Shared tsconfig, eslint, prettier
├── docs/             # All project documentation (start here)
└── package.json      # Bun workspaces root
```

Full breakdown: [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md).

---

## Documentation index

Read these in order — they are the source of truth for the build.

1. [docs/OVERVIEW.md](docs/OVERVIEW.md) — product scope, modules, assumptions
2. [docs/ROADMAP.md](docs/ROADMAP.md) — **the phased delivery plan**
3. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system design & data flow
4. [docs/TECH_STACK.md](docs/TECH_STACK.md) — stack decisions & rationale
5. [docs/PROJECT_STRUCTURE.md](docs/PROJECT_STRUCTURE.md) — folder conventions
6. [docs/DATA_MODEL.md](docs/DATA_MODEL.md) — MongoDB collections & relationships
7. [docs/API_DESIGN.md](docs/API_DESIGN.md) — REST conventions & endpoint map
8. [docs/DESIGN_SYSTEM.md](docs/DESIGN_SYSTEM.md) — tokens, type, motion, components
9. [docs/REALTIME.md](docs/REALTIME.md) — Socket.IO event contracts
10. [docs/SECURITY.md](docs/SECURITY.md) — auth, RBAC, audit, compliance
11. [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) — env vars & local setup

---

## Quick start

```bash
bun install                 # install all workspaces

# 1. Start MongoDB (replica set required) + Redis
docker compose up -d
bun run db:init             # initialize the rs0 replica set

# 2. Seed the first organization, system roles, and admin user
bun run seed                # admin@delta.local / ChangeMe123! (override via apps/api/.env)

# 3. Run everything
bun run dev                 # web (:3000) + api (:4000)
```

- Web: http://localhost:3000 → redirects to `/login`
- API: http://localhost:4000 (`/health` to check)

Env files for local dev already exist (`apps/api/.env`, `apps/web/.env.local`) and are
gitignored. See [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md).

> No Docker? Any MongoDB **replica set** works — point `MONGODB_URI` at it. A standalone
> mongod won't support the transactions later phases need.

---

## Status

**Phase 0 + authentication implemented and verified.** Working today:

- Bun monorepo (`apps/web`, `apps/api`, `packages/shared`) — typechecks + builds clean.
- **Auth:** NextAuth (Credentials, normal login) ↔ Express JWT + opaque refresh tokens
  with rotation & reuse-invalidation; argon2 password hashing; RBAC + org scoping.
- **Admin can create roles** (custom permission sets) **and create users** (incl. admins),
  with 4 seeded system roles (admin / accountant / salesperson / viewer).
- Delta design system tokens; premium two-panel login.
- **Dashboard shell** (shadcn `dashboard-01` style, in the Delta theme): collapsible
  sidebar with grouped nav + user footer, site header (search/notifications), KPI
  section cards, a cash-flow area chart (Recharts), and a recent-invoices table.
- Admin **Users** and **Roles** pages live under the shell.

Verified end-to-end: login, `/me`, role/user creation, RBAC denial (viewer → 403),
validation (422), and refresh rotation (old token → 401).

Next: **Phase 1** — accounting backbone (chart of accounts + ledger) and invoicing.
See [docs/ROADMAP.md](docs/ROADMAP.md).
