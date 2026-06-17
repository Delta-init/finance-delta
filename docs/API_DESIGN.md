# API Design

REST over HTTPS, JSON. Versioned under `/api/v1`. Realtime via Socket.IO ([REALTIME.md](REALTIME.md)).

## Conventions

- **Resource-oriented, plural nouns:** `/api/v1/invoices`, `/api/v1/customers`.
- **Org scope is implicit** from the authenticated session — never in the URL. The server
  derives `organizationId`; clients cannot query across orgs.
- **Standard verbs:** `GET` (list/read), `POST` (create), `PATCH` (partial update),
  `DELETE` (soft-delete where financial records require retention).
- **Actions that aren't CRUD** are sub-resources: `POST /invoices/:id/send`,
  `POST /invoices/:id/payments`, `POST /quotes/:id/convert`, `POST /bills/:id/approve`.
- **Validation:** every body/query parsed with the shared Zod schema; failures return 422.
- **Idempotency:** mutating financial POSTs accept an `Idempotency-Key` header.

## Response envelope

```jsonc
// success
{ "data": { /* resource or array */ }, "meta": { "page": 1, "pageSize": 25, "total": 240 } }

// error
{ "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [ … ] } }
```

Error `code` is a stable string enum (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`,
`VALIDATION_ERROR`, `CONFLICT`, `RATE_LIMITED`, `INTERNAL`). The frontend maps codes →
UX, never parses messages.

## List endpoints

Common query params: `?page=1&pageSize=25&sort=-createdAt&q=acme&status=overdue&
from=2026-01-01&to=2026-03-31`. Filters are whitelisted per resource.

## HTTP status usage

`200` ok · `201` created · `204` no content · `400` malformed · `401` unauthenticated ·
`403` forbidden (role) · `404` not found · `409` conflict (e.g. closed period) ·
`422` validation · `429` rate limited · `5xx` server.

## Auth

```
POST   /api/v1/auth/register          # creates user + organization
POST   /api/v1/auth/login             # → returns access token; refresh in httpOnly cookie
POST   /api/v1/auth/2fa/verify        # TOTP step
POST   /api/v1/auth/refresh           # rotate refresh, new access
POST   /api/v1/auth/logout
GET    /api/v1/auth/me
```

- **Access token:** short-lived JWT (15 min), sent as `Authorization: Bearer`.
- **Refresh token:** httpOnly, secure, sameSite cookie; rotated on use.

## Endpoint map (representative)

```
# Accounting backbone
GET/POST          /accounts
POST              /accounts/:id/opening-balance
GET/POST          /journal-entries
POST              /journal-entries/:id/reverse
GET               /ledger/:accountId            # running balance view

# Sales
GET/POST/PATCH    /customers
GET               /customers/:id/statement
GET/POST/PATCH    /quotes
POST              /quotes/:id/convert           # → invoice or sales order (partial ok)
GET/POST/PATCH    /sales-orders
GET/POST/PATCH    /invoices
POST              /invoices/:id/send            # email (+ custom message)
POST              /invoices/:id/payments        # record receipt (partial supported)
POST              /invoices/:id/reminders
GET               /invoices/:id/pdf
GET/POST          /credit-notes
POST              /credit-notes/:id/apply

# Purchasing
GET/POST/PATCH    /vendors
GET/POST/PATCH    /purchase-orders
POST              /purchase-orders/:id/convert  # → bill
GET/POST/PATCH    /bills
POST              /bills/:id/approve
POST              /bills/:id/payments
GET/POST          /vendor-credits

# Expenses & banking
GET/POST/PATCH    /expenses
POST              /expenses/:id/submit | /approve
GET/POST          /bank-accounts
POST              /bank-accounts/:id/import      # CSV/OFX upload (via R2)
GET               /bank-transactions
POST              /bank-transactions/:id/match
POST              /reconciliations

# Inventory
GET/POST/PATCH    /items
POST              /items/:id/adjust              # stock adjustment + reason
GET               /items/:id/valuation
GET/POST          /warehouses
GET/POST          /price-lists

# Reports (read-only, aggregation-backed)
GET /reports/receivables-aging
GET /reports/payables-aging
GET /reports/profit-loss?from&to&compare
GET /reports/balance-sheet?asOf
GET /reports/cash-flow
GET /reports/trial-balance
GET /reports/tax/vat-return?period   # UAE
GET /reports/tax/gst?period          # India
GET /reports/sales-by-item | /expense-by-category | /commission

# People & projects
GET/POST          /employees
POST              /payroll/runs
GET               /payroll/runs/:id/wps-export
GET/POST          /commission-structures
GET/POST          /loans
GET/POST          /projects
POST              /projects/:id/time-entries

# Documents & files
POST              /files/presign                 # → presigned PUT url + key
POST              /documents                      # register uploaded file metadata
GET               /documents/inbox
POST              /documents/:id/match

# Portals (scoped tokens)
GET               /portal/invoices | /statements
POST              /portal/invoices/:id/pay
POST              /portal/quotes/:id/accept | /decline
GET               /portal/purchase-orders        # vendor
POST              /portal/bills                   # vendor submits

# Automation & admin
GET/POST          /automation-rules
GET               /audit-logs
GET               /notifications
```

## File upload flow (R2)

```
1. client → POST /files/presign { fileName, mimeType, sizeBytes }
2. api    → returns { uploadUrl (presigned PUT), key }   (validates type/size/quota)
3. client → PUT file bytes directly to R2 (uploadUrl)
4. client → POST /documents { key, link:{module,refId} }  (api records metadata)
5. api    → optionally enqueues OCR job; emits document:created over socket
```

The API never proxies file bytes — only issues URLs and stores metadata.

## Rate limiting & security

- Per-IP and per-user token-bucket limits (stricter on `/auth/*`).
- All mutating endpoints behind RBAC middleware (see [SECURITY.md](SECURITY.md)).
- Closed-period guard: writes dated before `organization.closingDate` → `409 CONFLICT`.
