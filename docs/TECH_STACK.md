# Tech Stack & Decisions

Each choice below is locked for the build with a one-line rationale and the trade-off
we accepted.

## Runtime & language

- **Bun (backend runtime + package manager + test runner).** Fast installs, native TS,
  built-in test runner and `.env` loading. Trade-off: smaller ecosystem of Bun-specific
  tooling than Node — mitigated by Express running fine on Bun.
- **TypeScript everywhere**, `strict: true`. No `any` in domain code.

## Backend

- **Express** on Bun. Mature, well-understood middleware model, huge ecosystem.
  Trade-off vs. Hono/Elysia: slightly heavier, but the team familiarity and middleware
  availability win for an app this large.
- **Mongoose** for MongoDB. Schemas, hooks, and transactions (replica set required for
  multi-document transactions — the posting engine needs them).
- **Zod** for validation, shared with the frontend via `packages/shared`.
- **argon2** for password hashing; **otplib** for TOTP 2FA; **jsonwebtoken** for JWTs.
- **pino** for structured logging.
- **BullMQ (Redis)** for jobs — fallback `agenda` (Mongo) if avoiding Redis early.
- **PDF generation:** server-side via React-PDF (`@react-pdf/renderer`) or Puppeteer for
  pixel-perfect branded templates. Default: React-PDF (lighter, no headless Chrome).

## Database

- **MongoDB** with a **replica set** (single-node RS locally) so multi-document
  transactions work. Document model fits invoices/line-items well; aggregation pipelines
  power reports. Trade-off: we enforce double-entry integrity in the app layer (and with
  transactions) rather than relying on SQL constraints — documented in ARCHITECTURE.

## File storage

- **Cloudflare R2** via the S3-compatible API (`@aws-sdk/client-s3` +
  `@aws-sdk/s3-request-presigner`). **Presigned uploads** — the browser PUTs directly to
  R2, the API only issues URLs and records metadata. Zero egress fees vs. S3.

## Realtime

- **Socket.IO.** Rooms per organization, reconnection, and fallback transport handled.
  Trade-off vs. raw WS: a bit heavier, but rooms + ack + reconnection out of the box.

## Frontend

- **Next.js (App Router)** — RSC for read-heavy financial views, client components for
  builders. SSR/streaming for fast first paint on big tables.
- **Tailwind CSS** driven by Delta design tokens (CSS variables, OKLCH). See
  [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).
- **shadcn/ui** as the *primitive layer only* (Radix under the hood for a11y). We restyle
  every primitive to the Delta DS and compose higher-level components in `packages/ui` —
  so it does **not** look like default shadcn.
- **Framer Motion** for motion. Used surgically: page/route transitions, list reordering,
  modal/sheet choreography, number count-ups on dashboards. Never gratuitous.
- **TanStack Query (React Query)** is the single owner of server state — fetching,
  caching, optimistic mutations, and invalidation (including from Socket.IO events).
  No data is hand-cached in components or Zustand.
- **React Hook Form + Zod** for every form, using the *same* schemas from
  `packages/shared` (`@hookform/resolvers/zod`) — one validation definition, web + api.
- **Zustand** for small, ephemeral global UI state only (command palette, theme, toasts,
  sidebar collapse). Never for server data — that's React Query's job.
- **NextAuth (Auth.js v5)** owns the frontend session. A **Credentials provider**
  delegates to the Express API for credential + 2FA verification; NextAuth stores the
  resulting tokens in an encrypted, httpOnly session cookie and refreshes them in its
  `jwt` callback. See ARCHITECTURE and SECURITY for the full flow.
- **TanStack Table** for the heavy data grids (invoices, ledger, reconciliation).
- **Recharts** (or Visx for custom) for report charts.

## Tooling

- **ESLint + Prettier** shared via `packages/config`.
- **Vitest/Bun test** for unit; **Supertest** for API integration; **Playwright** for e2e.
- **GitHub Actions:** typecheck → lint → unit → integration on PR.
- **Docker Compose** for local Mongo (RS) + Redis.

## Deliberately deferred (with adapter seams now)

- **Live bank feeds** (Plaid/Lean/Salt Edge) — interface defined, manual import first.
- **Payment gateway** (Stripe/Telr/Network Intl) — `PaymentGateway` interface in Phase 1,
  concrete impl in Phase 6.
- **OCR** (Textract/Google Doc AI) — `OcrProvider` interface, async job.
- **E-invoicing** (ZATCA/GST) — `EInvoiceProvider` interface, per-jurisdiction impl.

Defining these as interfaces now keeps the domain clean and the vendor swappable.
