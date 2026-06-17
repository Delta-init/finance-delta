# Security, Access Control & Compliance

Accounting data is sensitive and regulated. Security is a Phase 0 concern, not a
retrofit.

## Authentication

Split responsibility: **NextAuth (Auth.js)** owns the browser session; the **Express API**
is the identity authority (credentials, 2FA, token issuance/rotation, RBAC). See the auth
flow in [ARCHITECTURE.md](ARCHITECTURE.md).

- **Passwords:** hashed with **argon2id** (memory-hard) in the Express API. Never stored
  or logged in plain. NextAuth never sees the hash — it calls the API to verify.
- **Tokens (issued by the API):**
  - Access JWT — 15 min, carries `userId`, `organizationId`, `role`, `permissions` hash.
    Sent to the API as `Authorization: Bearer` (also used by Socket.IO + mobile).
  - Refresh token — random opaque, stored hashed server-side; **rotated on every use**
    (reuse detection revokes the token family).
- **Session storage (NextAuth):** tokens + claims live in NextAuth's **encrypted,
  httpOnly, Secure, SameSite=Lax** session cookie (JWT strategy). The browser never holds
  tokens in `localStorage`/JS-readable storage. NextAuth's `jwt` callback performs the
  refresh-rotation call to the API before access-token expiry.
- **2FA (req. 19):** TOTP (otplib) with QR enrollment + recovery codes, verified by the
  API; surfaced as a second step in the NextAuth Credentials flow. Enforceable per-org
  (admins can require it for all users).
- **Sessions:** server-side refresh-token revocation list; "log out all devices" revokes
  the family and NextAuth sign-out clears the cookie.
- **Portals:** client/vendor logins use the same NextAuth setup with portal-scoped roles;
  the API narrows their token to their own customer/vendor records.

## Authorization (RBAC — req. 19)

Roles: `admin · accountant · salesperson · viewer` (+ portal roles `client`, `vendor`,
and `external-accountant` for read-only invited access).

- A **permissions matrix** lives in `packages/shared/constants/permissions.ts` mapping
  role → allowed `(resource, action)` pairs. Example: `salesperson` cannot read `payroll`.
- **Backend** is the enforcement point: `rbac(resource, action)` middleware on every
  route. The frontend hides what a role can't do, but never *relies* on hiding.
- **Org scoping** (`orgScope` middleware) is layered on top: every query is filtered by
  the session's `organizationId`; portal tokens are further narrowed to their own
  customer/vendor records.

## Audit trail (req. 19)

- Every mutating service writes an **append-only** `auditLogs` entry: `userId, action,
  entity, before, after, ip, timestamp`.
- Implemented centrally (a service-layer wrapper / Mongoose middleware) so coverage is
  automatic, not per-endpoint discipline.
- Audit logs are immutable (no update/delete routes) and retained per policy.

## Financial integrity controls

- **Period close (req. 16):** writes dated on/before `organization.closingDate` are
  rejected (`409 CONFLICT`). Reopening requires admin + is itself audited.
- **No hard deletes** of posted financial documents — they're voided/reversed (credit
  notes, journal reversals) to preserve history.
- **Locked commission methods (req. 9):** changing a locked structure requires admin
  approval, tracked.
- **Approval workflows (req. 4, 5, 17):** bills/expenses/credit notes above configured
  thresholds require approval before posting/payment.

## Input & transport security

- All input validated by Zod at the boundary (reject unknown fields).
- HTTPS only; HSTS. Secure cookies. CORS locked to known web origins.
- Security headers via `helmet` (CSP, X-Content-Type-Options, frame-ancestors).
- Rate limiting (token bucket), stricter on `/auth/*`; brute-force lockout + backoff.
- Mongo injection avoided via Mongoose + typed queries (never build queries from raw
  user objects).

## File security (R2)

- Presigned URLs are **short-lived** and scoped to a single key/operation.
- Server validates declared `mimeType` + `sizeBytes` and enforces per-org storage quotas
  before issuing a presign.
- Stored objects are private; downloads go through short-lived presigned GETs, never
  public URLs. Keys are namespaced `org/<orgId>/<module>/<uuid>`.
- Uploaded files are scanned (AV hook) before being marked usable, where required.

## Secrets & config

- All secrets via environment ([ENVIRONMENT.md](ENVIRONMENT.md)); never committed.
- JWT signing keys, R2 keys, DB creds rotated on a schedule; `.env` is gitignored;
  `.env.example` documents shape only.

## Compliance (req. 18)

- **UAE VAT:** 5% calculation, TRN capture/validation, VAT return report (output/input/
  net payable).
- **India GST:** CGST/SGST/IGST split on invoices; GST reports; TDS handling.
- **E-invoicing:** provider-adapter seam (ZATCA / GST e-invoice) — activated per
  jurisdiction.
- **WPS (payroll):** SIF-format export for UAE Wage Protection System.
- **Data retention:** financial records retained per local statutory periods; audit logs
  immutable.
- **PII:** customer/vendor/employee PII access is role-gated and audited.

## Pre-production checklist (Phase 7)

- [ ] Dependency + container vuln scan in CI
- [ ] Penetration test (auth, RBAC bypass, IDOR across orgs, file presign abuse)
- [ ] Secrets rotation runbook
- [ ] Backup + restore drill (Mongo PITR)
- [ ] Rate-limit + lockout tuning under load
- [ ] WCAG AA audit (also a security-adjacent quality gate)
