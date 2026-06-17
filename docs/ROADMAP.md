# Roadmap — Phased Delivery Plan

The build is sequenced so the **accounting backbone (ledger + tax + money)** lands first,
because every later module posts to it. We ship vertical slices that are demoable and
correct, not horizontal layers that only connect at the end.

Each phase lists: **Goal · Backend · Frontend · Done-when**.

---

## Phase 0 — Foundation & scaffolding

**Goal:** A running monorepo with auth, CI, and the design system shell.

- **Repo:** Bun workspaces (`apps/web`, `apps/api`, `packages/shared|ui|config`).
- **Backend:** Express server, MongoDB connection, Zod request validation middleware,
  error envelope, structured logging (pino), health check, Socket.IO server boot.
- **Auth (API):** signup/login, JWT access+refresh, password hashing (argon2), 2FA
  (TOTP) scaffold, refresh rotation + revocation, RBAC middleware, `organizationId`
  request scoping.
- **Auth (web):** NextAuth (Auth.js) Credentials provider wired to the API, encrypted
  session cookie, `jwt`/`session` callbacks with refresh rotation, Next.js middleware
  route protection for `(app)` + `/portal`.
- **Frontend:** Next.js App Router, Delta design tokens wired (Tailwind + CSS vars),
  base shadcn primitives restyled, app shell (sidebar, topbar, command palette),
  auth pages, Framer Motion page-transition primitives.
- **Data/forms baseline:** React Query provider + API client (Bearer from session),
  React Hook Form + Zod resolver wiring against `packages/shared`, Zustand UI store.
- **Infra:** `.env.example`, R2 bucket + presign endpoint smoke test, Docker compose
  for local Mongo, GitHub Actions (typecheck, lint, test).

**Done-when:** A user can sign up, create an organization, log in with 2FA, and land on
an empty themed dashboard. Upload a test file to R2 via presigned URL.

---

## Phase 1 — Accounting backbone + Invoicing core

**Goal:** Create a customer, raise an invoice, record a payment — fully posted to the GL.

- **Chart of Accounts & General Ledger (req. 16):** account types, journal entries,
  running balances, opening balances, period-close lock. Double-entry posting engine.
- **Money & Tax engine (req. 18):** integer minor units, currency model, manual + live
  FX rates, VAT/GST/TDS calculators, per-line tax.
- **Customers (req. 3):** CRUD, unique Customer ID, tags, price-list assignment,
  customer statement view.
- **Invoicing (req. 2.1–2.4):** invoice builder (line items, discount, tax, totals),
  statuses, payment receipts, partial payments, credit notes, PDF generation.
- **RBAC enforcement (req. 19):** role-gated routes + UI; audit trail on all mutations.

**Done-when:** Invoice raised → GL shows AR + revenue + tax postings; payment recorded →
balances reconcile; credit note reduces outstanding; PDF downloads; audit log records it.

---

## Phase 2 — Quotes, Sales Orders, Expenses, Documents

**Goal:** Pre-sales pipeline + spending, with file attachments everywhere.

- **Quotations & Sales Orders (req. 1):** statuses, expiry auto-flagging (scheduled job),
  one-click convert to invoice/SO, partial conversion.
- **Expense Management (req. 5):** categories, receipt attachments (R2), recurring
  expenses, mileage, submit→approve workflow, project/cost-centre linking.
- **Document Management (req. 15):** attach to any transaction, central document inbox,
  OCR job hook (async), match-to-transaction.
- **Recurring & scheduling infra:** job scheduler (BullMQ or agenda) powering recurring
  invoices/expenses, expiry flags, reminders.

**Done-when:** Quote → invoice conversion works; an expense with a receipt flows through
approval; documents land in the inbox and attach to a transaction.

---

## Phase 3 — Payables + Inventory

**Goal:** The buy side and stock.

- **Purchase Orders & Bills (req. 4):** PO lifecycle, PO→bill conversion, vendor bills
  with terms, partial payment, approval workflow, vendor credits.
- **Vendors (req. 13):** records, unique Vendor ID, statements (bills/payments/credits).
- **Inventory (req. 7):** items (SKU, cost/price, UoM), real-time stock with auto-deduct
  on invoice, reorder points + low-stock alerts (realtime), multi-warehouse, manual
  adjustments with reason logging, FIFO valuation, item photos (R2), price lists.

**Done-when:** PO → bill → payment posts to GL; selling an item deducts stock and a
low-stock alert fires over Socket.IO; FIFO valuation report matches movements.

---

## Phase 4 — Banking, Reconciliation & Reporting

**Goal:** Close the loop with bank matching and the full report suite.

- **Banking (req. 6):** multi-account, manual import (CSV/Excel/OFX), transaction
  matching to invoices/bills/expenses, duplicate/unmatched flagging, running balance,
  reconciliation report, petty cash. (Live bank feeds = follow-on integration.)
- **Reporting (req. 8):** receivables (aged AR, by salesperson/customer/tag), payables
  (aged AP), P&L (monthly/annual + comparative), Balance Sheet, Cash Flow, trial
  balance, general ledger, sales-by-item, expense-by-category.
- **Tax reports (req. 8.6):** UAE VAT return, India GST, tax summary by rate/period.

**Done-when:** Import a statement, match transactions, produce a reconciliation report;
P&L, Balance Sheet, and VAT return generate from ledger data and tie out.

---

## Phase 5 — Commission, Loans, Payroll, Projects

**Goal:** People & finance operations.

- **Commission Portal (req. 9):** flat/percentage/tiered structures, auto-calc on
  invoices/payments, locked methods (admin approval to change), earned/paid/pending.
- **Loans & Credit (req. 10):** principal/interest/schedule, repayment tracking,
  automated interest accrual entries, loan summary.
- **Payroll (req. 11):** employee records, monthly salary runs (gross/net), advances &
  deductions, salary slips, WPS export, GL posting.
- **Project Accounting (req. 12):** projects with budgets/timelines, billable/non-billable
  hours, project expense linkage, profitability reports, bill T&M from projects.

**Done-when:** A salary run posts to the GL and exports WPS; commissions compute from
invoices; a loan accrues interest; a project shows profitability.

---

## Phase 6 — Portals & Automation

**Goal:** External access + hands-off operations.

- **Client Portal (req. 14):** secure client login, view invoices/statements/history,
  accept/decline quotes, **online payment** (gateway adapter), per-org branding.
- **Vendor Portal (req. 13):** vendor login, view POs, submit bills.
- **Workflow Automation (req. 17):** event triggers (overdue → reminder), auto-tagging,
  threshold approval workflows, scheduled report emailing.

**Done-when:** A client logs into a branded portal, pays an invoice online, and the
payment posts; an overdue invoice auto-sends a reminder.

---

## Phase 7 — Mobile & hardening

**Goal:** Cross-platform reach + production hardening.

- **Mobile (req. 20):** native app (Expo/React Native) reusing the API for invoicing,
  expenses, reports; **offline mode** with sync queue.
- **Hardening:** load testing, report query optimization (materialized summaries),
  backups, observability, penetration test, accessibility audit.

**Done-when:** Mobile app ships core flows; offline transactions sync; security review
and a11y audit pass.

---

## Cross-cutting tracks (run continuously)

- **Testing:** unit (money/tax/posting engines first), integration (API), e2e (Playwright).
- **Audit & compliance:** audit trail extended with every new mutating endpoint.
- **Performance:** financial reports backed by aggregation pipelines + cached summaries.
- **Design polish:** every module ships against the design system, not after.

## Sequencing rationale

The ledger, money, and tax engines are built once in Phase 1 and reused everywhere.
Getting double-entry right early means reports in Phase 4 are derivations, not rewrites —
and prevents the classic "the numbers don't tie out" rebuild.
