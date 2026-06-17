# Project Structure & Conventions

Bun workspaces monorepo. Code is grouped by **domain module**, not by technical type, so
everything about "invoices" lives together.

## Top level

```
delta-finance/
├── apps/
│   ├── web/                      # Next.js frontend
│   └── api/                      # Bun + Express backend + job worker
├── packages/
│   ├── shared/                   # Zod schemas, types, money/tax/fx utils, constants
│   ├── ui/                       # Delta design-system components
│   └── config/                   # tsconfig, eslint, prettier, tailwind preset
├── docs/
├── docker-compose.yml            # local Mongo (replica set) + Redis
├── .env.example
├── package.json                  # workspaces + root scripts
└── tsconfig.base.json
```

## `apps/api` — backend

```
apps/api/
├── src/
│   ├── index.ts                  # Express + Socket.IO boot
│   ├── worker.ts                 # background job worker entry
│   ├── config/                   # env parsing (zod), db, redis, r2 clients
│   ├── middleware/               # auth, rbac, orgScope, validate(zod), errorHandler
│   ├── lib/
│   │   ├── posting/              # the double-entry posting engine
│   │   ├── money/                # re-exports from packages/shared
│   │   ├── tax/                  # VAT/GST/TDS calculators
│   │   ├── fx/                   # exchange-rate provider + gain/loss
│   │   ├── pdf/                  # invoice/receipt/report templates
│   │   └── realtime/             # socket server + emit helpers
│   ├── modules/                  # ── one folder per domain ──
│   │   ├── auth/
│   │   ├── organization/
│   │   ├── ledger/               # chart of accounts, journal, GL
│   │   ├── customer/
│   │   ├── invoice/
│   │   │   ├── invoice.model.ts        # Mongoose schema
│   │   │   ├── invoice.repository.ts   # DB access
│   │   │   ├── invoice.service.ts      # domain logic (calls posting engine)
│   │   │   ├── invoice.controller.ts   # HTTP handlers
│   │   │   ├── invoice.routes.ts       # express.Router
│   │   │   └── invoice.test.ts
│   │   ├── quote/  expense/  vendor/  bill/  purchaseOrder/
│   │   ├── inventory/  banking/  report/  commission/  loan/
│   │   ├── payroll/  project/  document/  portal/  automation/
│   └── jobs/                     # recurring, reminders, expiry, ocr, scheduledReports
└── package.json
```

**Module file convention** (every module follows it): `model · repository · service ·
controller · routes · test`. Predictable — you always know where a thing lives.

## `apps/web` — frontend

```
apps/web/
├── src/
│   ├── app/                      # Next.js App Router
│   │   ├── (auth)/               # login, signup, 2fa  (no app shell)
│   │   ├── (app)/                # authenticated shell (sidebar + topbar)
│   │   │   ├── dashboard/
│   │   │   ├── invoices/
│   │   │   ├── customers/
│   │   │   ├── expenses/  bills/  banking/  inventory/  reports/  ...
│   │   │   └── layout.tsx
│   │   ├── portal/               # client/vendor portals (own branded shell)
│   │   └── api/                  # route handlers only if needed (BFF proxy)
│   ├── components/               # app-specific composed components
│   ├── features/                 # feature logic mirrors api modules (hooks, forms)
│   │   └── invoice/              # useInvoices, InvoiceForm, invoice.api.ts
│   │   └── api/auth/[...nextauth]/  # NextAuth route handler
│   ├── auth.ts                   # NextAuth config (Credentials provider, callbacks)
│   ├── middleware.ts             # NextAuth route protection for (app)/portal
│   ├── lib/                      # api client (Bearer from session), query client,
│   │                             #   socket client, utils
│   ├── providers/                # QueryClientProvider, SessionProvider, ThemeProvider
│   ├── hooks/
│   └── styles/                   # globals.css (tokens), tailwind
└── package.json
```

## `packages/shared`

The contract between web and api. **No runtime framework deps.**

```
packages/shared/src/
├── schemas/        # zod: invoice.schema.ts, customer.schema.ts, ... (one per domain)
├── types/          # inferred TS types (z.infer) + enums (statuses, roles)
├── money/          # Money class, rounding, allocation
├── tax/            # tax rule types
├── constants/      # currencies, account types, permissions matrix
└── index.ts
```

## `packages/ui`

The Delta design system — restyled shadcn primitives + composed components.

```
packages/ui/src/
├── primitives/     # button, input, select, dialog, sheet, table, badge ... (restyled)
├── components/     # DataTable, StatCard, MoneyDisplay, StatusPill, PageHeader, EmptyState
├── motion/         # Framer Motion variants & wrappers (FadeIn, Stagger, PageTransition)
└── tokens/         # exported design tokens (also consumed by tailwind preset)
```

## Naming conventions

- Files: `kebab-case.ts` for modules, `PascalCase.tsx` for React components.
- DB: collections plural lowercase (`invoices`); fields camelCase.
- Money fields: `<name>Minor` (integer) + sibling `currency`.
- IDs exposed to users (Customer ID / Vendor ID) are human-readable sequences per org,
  separate from Mongo `_id`.
- Branches: `feat/…`, `fix/…`, `chore/…`. Conventional Commits.

## Root scripts

```jsonc
{
  "scripts": {
    "dev":        "bun run --filter '*' dev",   // web + api concurrently
    "build":      "bun run --filter '*' build",
    "typecheck":  "bun run --filter '*' typecheck",
    "lint":       "bun run --filter '*' lint",
    "test":       "bun test"
  }
}
```
