# Product Overview

Delta Finance is an internal business management system targeting **Zoho Books feature
parity**. It manages the full commercial lifecycle: quote → order → invoice → payment,
alongside payables, expenses, banking, inventory, payroll, projects, and reporting.

## Guiding principles

1. **Correctness over cleverness.** This is accounting software. Money math must be
   exact (integer minor units, never floats), and every financial mutation must be
   auditable and reversible by design (credit notes, journal reversals).
2. **Double-entry under the hood.** Even when the UI hides it, every transaction posts
   to the general ledger. Reports are derived from the ledger, not bolted on.
3. **Org-scoped multi-tenancy.** Every record carries an `organizationId`. Portals
   (client/vendor) are scoped views into the same data.
4. **Premium, calm UI.** Dense financial data presented clearly: tabular numerals,
   restrained color, purposeful motion. See [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).
5. **Compliance-first.** UAE VAT (5%, TRN, VAT return), India GST (CGST/SGST/IGST),
   TDS, and WPS payroll export are core, not add-ons.

## Module map (from the requirements)

| #  | Module                         | Phase | Notes |
| -- | ------------------------------ | ----- | ----- |
| 1  | Quotations & Sales Orders      | 2     | Convert to invoice/SO, expiry flagging |
| 2  | Invoicing                      | 1     | Recurring, progress, multi-currency, delivery tracking |
| 3  | Customer Management            | 1     | Statements, portal access, price lists, tags |
| 4  | Purchase Orders & Bills        | 3     | PO → bill, approval workflows |
| 5  | Expense Management             | 2     | Receipts (R2 + OCR), recurring, approval, mileage |
| 6  | Banking & Reconciliation       | 4     | Import (CSV/OFX), matching, multi-account |
| 7  | Inventory Management           | 3     | Real-time stock, reorder alerts, FIFO valuation |
| 8  | Reporting & Financial Summaries| 4     | P&L, Balance Sheet, Cash Flow, aged AR/AP, tax |
| 9  | Commission Portal              | 5     | Flat/percentage/tiered, locked methods |
| 10 | Loans & Credit                 | 5     | Interest accrual, repayment schedules |
| 11 | Payroll & Staff Payments       | 5     | Salary runs, slips, WPS export |
| 12 | Project Accounting             | 5     | Time logging, profitability |
| 13 | Vendor Portal                  | 6     | View POs, submit bills |
| 14 | Client Portal                  | 6     | View/pay invoices, accept quotes |
| 15 | Document Management            | 2     | R2 attachments, document inbox, OCR |
| 16 | Chart of Accounts & GL         | 1     | The accounting backbone — built early |
| 17 | Workflow Automation            | 6     | Event triggers, scheduled reports |
| 18 | Multi-Currency & Tax Compliance| 1/4   | Rates engine + tax engine |
| 19 | User Roles & Access Control    | 0/1   | RBAC, 2FA, audit trail |
| 20 | Mobile & Cross-Platform        | 7     | Responsive web first; native app later |

Phases are defined in [ROADMAP.md](ROADMAP.md).

## Explicit assumptions (confirm / adjust)

- **Monorepo** with Bun workspaces (confirmed).
- **Multi-tenant**, organization-scoped (confirmed).
- **Web-responsive first**; native iOS/Android (req. 20) deferred to a later phase,
  reusing the same API. Offline mode is a Phase 7 concern.
- **Bank feeds** (req. 6, automatic import) require a third-party aggregator
  (e.g. Plaid/Lean/Salt Edge). Phase 4 ships **manual CSV/OFX import** first;
  live feeds are a follow-on integration.
- **OCR** (req. 15) starts as an async job hook; provider (Textract / Google Document
  AI / open-source) chosen in Phase 2.
- **E-invoicing** (ZATCA / GST e-invoice) is stubbed with a provider-adapter interface
  and implemented when a jurisdiction is activated.
- **Online payments** in portals require a gateway (Stripe / Telr / Network Intl for
  UAE). Adapter interface defined early; concrete gateway in Phase 6.
