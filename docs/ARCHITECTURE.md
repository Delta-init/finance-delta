# Architecture

## High-level

```
┌─────────────────┐     HTTPS / WSS      ┌──────────────────────┐
│   Next.js (web) │ ───────────────────► │  Express API (Bun)   │
│  App Router     │ ◄─────────────────── │                      │
│  RSC + client   │   REST + Socket.IO   │  ┌────────────────┐  │
└─────────────────┘                      │  │ Domain services │  │
        │                                │  │ (posting, tax,  │  │
        │ presigned PUT                  │  │  money, reports)│  │
        ▼                                │  └────────────────┘  │
┌─────────────────┐                      │          │           │
│  Cloudflare R2  │ ◄────────────────────┼──────────┘           │
│ (files, OCR in) │   presign + webhook  │          │           │
└─────────────────┘                      └──────────┼───────────┘
                                                     ▼
                                          ┌──────────────────────┐
                                          │      MongoDB          │
                                          │ (org-scoped, GL core) │
                                          └──────────────────────┘
                  ┌──────────────────────┐         ▲
                  │  Job worker (Bun)     │ ────────┘
                  │ recurring, reminders, │
                  │ OCR, scheduled reports│
                  └──────────────────────┘
```

## Layers (backend)

Requests flow through clear layers; **business logic never lives in route handlers**.

```
HTTP route  →  controller  →  service (domain logic)  →  repository (Mongoose)  →  Mongo
                  │                  │
                  │                  └─ uses: posting engine, money, tax, fx
                  └─ Zod validation (shared schema), RBAC guard, org scope
```

- **Controllers** parse/validate (Zod), enforce auth + org scope, call services, shape
  the response envelope. No DB calls, no math.
- **Services** own domain logic and transactions. Anything that touches money calls the
  **posting engine** so the ledger stays the single source of truth.
- **Repositories** wrap Mongoose models; the only layer that talks to the DB.

## The posting engine (the heart)

Every financial event (invoice, payment, bill, expense, payroll, accrual) produces a
**balanced journal entry** (sum of debits == sum of credits) posted to the General
Ledger inside a MongoDB transaction. Module documents (e.g. an Invoice) store a
reference to the journal entry, not duplicated balances. Reports read the ledger.

```
createInvoice() ──► invoiceRepo.save()            ┐
                ──► postingEngine.post({          │  one Mongo
                      debit:  AR account,         │  transaction
                      credit: Revenue + Tax,      │  (all-or-nothing)
                    })                            ┘
```

This is why ROADMAP Phase 1 builds the ledger before anything else.

## Money handling

- Stored as **integer minor units** (`amountMinor: 1050` = AED 10.50) + `currency`.
- A shared `Money` utility in `packages/shared` does all arithmetic, rounding, and
  allocation (e.g. splitting a discount across lines) — never raw `number` math.
- FX: amounts are stored in both the document currency and the org base currency, with
  the rate used; currency gain/loss is computed at settlement.

## Multi-tenancy

- Every collection has `organizationId` (indexed). A request-scoped middleware injects
  it and every repository query is org-filtered by default.
- Portal users (client/vendor) authenticate into a restricted scope: they see only their
  own customer/vendor records within an org.

## Realtime

Socket.IO rooms are keyed `org:<organizationId>` (and `user:<id>` for personal events).
Domain services emit events after a successful commit. See [REALTIME.md](REALTIME.md).

## Background jobs

A dedicated worker process (same codebase, `apps/api` worker entry) handles:
recurring invoices/expenses, payment reminders, quote-expiry flagging, OCR processing,
scheduled report emails, and interest accrual. Queue: BullMQ (Redis) — or `agenda`
(Mongo-backed) if we want to avoid a Redis dependency early.

## Frontend architecture

- **Server Components** for data-heavy read views (lists, reports) — fetch on the server,
  stream to the client.
- **Client Components** for interactive builders (invoice editor, reconciliation) and
  anything using Socket.IO or Framer Motion.
- **Data layer:** TanStack Query (React Query) owns all client server-state —
  caching, mutations, and invalidation (also driven by Socket.IO events). RSC `fetch`
  for initial server loads. Forms via React Hook Form + shared Zod schemas.
- **State:** server state via React Query; minimal ephemeral UI state via Zustand
  (theme, command palette, toasts, sidebar). No Redux. Zustand never holds server data.
- **Auth:** NextAuth (Auth.js) owns the session; see the auth flow below.

## Auth flow (NextAuth ↔ Express)

NextAuth handles the **frontend session**; the Express API remains the **source of truth**
for credentials, 2FA, RBAC, and refresh-token rotation. They connect via a Credentials
provider:

```
1. login form → NextAuth Credentials.authorize()
2. authorize() → POST /api/v1/auth/login (Express verifies argon2 + issues tokens)
   ├─ 2FA required? → NextAuth returns a "2fa" step; UI collects TOTP
   │                  → POST /api/v1/auth/2fa/verify → tokens
   └─ tokens = { accessToken (15m), refreshToken, user{ id, role, organizationId } }
3. NextAuth jwt() callback stores tokens + claims in an encrypted httpOnly cookie
4. NextAuth session() exposes { user, role, organizationId } to the app (RSC + client)
5. API client attaches accessToken as Bearer on every request
6. accessToken near expiry → NextAuth jwt() calls POST /api/v1/auth/refresh
   (rotating refresh) and updates the session transparently
7. refresh reuse / failure → session invalidated → redirect to login
```

- **Why both:** NextAuth gives us first-class Next.js session ergonomics (middleware
  route protection, `auth()` in RSC, secure cookie handling) while the Express backend
  stays framework-agnostic and authoritative — the same JWTs also authenticate the mobile
  app and Socket.IO handshake later. NextAuth is **not** the identity store; Mongo is.
- **Route protection:** Next.js middleware gates the `(app)` and `/portal` segments on a
  valid session; the API independently enforces RBAC + org scope (defense in depth — the
  client is never trusted).

## Why these boundaries

The `packages/shared` Zod schemas are imported by *both* the API (validation) and the web
(forms + types). One definition of an Invoice, enforced on both ends — no drift.
