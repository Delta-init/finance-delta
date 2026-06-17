# Data Model

MongoDB, org-scoped. Every collection includes:

```ts
organizationId: ObjectId   // indexed; every query filtered by it
createdBy / updatedBy: ObjectId
createdAt / updatedAt: Date
```

Money is always `{ amountMinor: number, currency: string }` (integer minor units).
Foreign-currency docs also store `baseAmountMinor` + `exchangeRate`.

> This is the conceptual model — field lists are representative, not exhaustive. The
> authoritative shapes live in `packages/shared/src/schemas`.

---

## Core / tenancy

### organizations
`name, legalName, branding {logoKey, primaryColor, footerText}, baseCurrency,
addresses[], taxRegistration {trn, gstin}, fiscalYearStart, closingDate`

### users
`name, email (unique per org), passwordHash, role, twoFactor {enabled, secret},
status, lastLoginAt`

### memberships  *(user ↔ organization, many-to-many for external accountants)*
`userId, organizationId, role, permissions[]`

### roles / permissions
RBAC matrix lives in `packages/shared/constants`. Roles: `admin · accountant ·
salesperson · viewer · client · vendor`. See [SECURITY.md](SECURITY.md).

---

## Accounting backbone

### accounts  *(Chart of Accounts — req. 16)*
`code, name, type (income|expense|asset|liability|equity), subtype, parentId,
isActive, openingBalanceMinor, currency`

### journalEntries  *(req. 16 — the ledger)*
```
date, memo, source {module, refId},   // e.g. {module:'invoice', refId:…}
lines: [{ accountId, debitMinor, creditMinor, description }],
status (posted|draft|void), reversalOf?   // sum(debit) === sum(credit) enforced
```
Reports are aggregations over `journalEntries.lines`.

### fxRates
`base, quote, rate, date, source (manual|live)`

---

## Sales

### customers  *(req. 3)*
`customerCode (per-org sequence), fullName*, phone*, email*, companyName, billingAddress,
shippingAddress, trn, currencyPreference, priceListId, tags[], portalUserId, status`
(* mandatory)

### quotations  *(req. 1)*
`quoteNumber, customerId, lineItems[], subtotalMinor, taxLines[], totalMinor, currency,
status (draft|sent|accepted|declined|expired), expiryDate, convertedTo {invoiceId|orderId}`

### salesOrders  *(req. 1)*
`orderNumber, customerId, lineItems[], status, sourceQuoteId, fulfilledQty`

### invoices  *(req. 2)*
```
invoiceNumber, customerId, salespersonId*,   // mandatory salesperson (req. 2.1)
reference/tag, lineItems: [{ itemId?, description, qty, unitPriceMinor,
  discount, taxCodes[], lineTotalMinor }],
subtotalMinor, taxLines[], totalMinor, amountPaidMinor, balanceMinor, currency,
exchangeRate, status (draft|sent|viewed|paid|overdue|partial),
dueDate, recurring {frequency, nextRunAt}?, progress {contractId, stage}?,
journalEntryId, deliveryLog[]   // sent/viewed/reminder events
```

### creditNotes  *(req. 2.3)*
`creditNoteNumber, customerId, invoiceId, lineItems[], totalMinor, appliedMinor,
journalEntryId`

### payments  *(req. 2.4 — receipts)*
`paymentNumber, customerId, date, method (cash|bank|card|cheque), depositAccountId,
allocations: [{ invoiceId, amountMinor }], totalMinor, currency, reference, journalEntryId`

---

## Purchasing

### vendors  *(req. 13)*
`vendorCode, name, contact, trn, bankDetails, currency, tags[], portalUserId, statement…`

### purchaseOrders  *(req. 4.1)*
`poNumber, vendorId, lineItems[], status (draft|sent|received|billed|cancelled),
convertedBillId`

### bills  *(req. 4.2 — payables)*
`billNumber, vendorId, sourcePoId, lineItems[], totalMinor, amountPaidMinor, balanceMinor,
dueDate, terms, approval {status, approverId}, journalEntryId`

### vendorCredits  *(req. 4.3)*
`vendorId, billId, amountMinor, appliedMinor, journalEntryId`

### billPayments
`vendorId, allocations[{billId, amountMinor}], method, paymentAccountId, journalEntryId`

---

## Expenses & banking

### expenses  *(req. 5)*
`category, date, amountMinor, paymentAccountId, vendorId?, projectId?, costCentreId?,
attachments[docId], recurring {frequency}?, mileage {distance, rate}?,
approval {status, submitterId, approverId}, journalEntryId`

### bankAccounts  *(req. 6)*
`name, type (bank|cash|pettyCash), currency, glAccountId, currentBalanceMinor`

### bankTransactions  *(req. 6)*
`bankAccountId, date, amountMinor, direction (debit|credit), description, importBatchId,
match {type (invoice|bill|expense|manual), refId}?, status (unmatched|matched|duplicate),
runningBalanceMinor`

### reconciliations
`bankAccountId, periodStart, periodEnd, statementBalanceMinor, bookBalanceMinor,
status, clearedTransactionIds[]`

---

## Inventory

### items  *(req. 7)*
`name, sku (unique per org), description, type (good|service), unitPriceMinor,
costPriceMinor, uom, reorderPoint, photos[r2Key], isActive, glAccounts {income, cogs, asset}`

### stockLevels
`itemId, warehouseId, quantity, valuationLayers[{qty, unitCostMinor, receivedAt}]` (FIFO)

### warehouses
`name, location, isDefault`

### stockMovements
`itemId, warehouseId, qty, direction (in|out), reason (sale|purchase|adjustment|transfer),
ref, unitCostMinor`

### priceLists  *(req. 3, 7)*
`name, type (markup|discount), rules[{itemId?, group?, adjustmentPct|fixedMinor}]`

---

## People & projects

### employees  *(req. 11)*
`name, role, salaryStructure {basicMinor, allowances[], deductions[]}, bankDetails (IBAN
for WPS), joinDate, status`

### payrollRuns
`period, lines[{employeeId, grossMinor, deductionsMinor, netMinor}], status,
journalEntryId, wpsExportKey?`

### advances
`employeeId, amountMinor, date, recoverySchedule[], outstandingMinor`

### commissionStructures  *(req. 9)*
`salespersonId, method (flat|percentage|tiered), config, locked (bool), lockApprovalId?`

### commissions
`salespersonId, period, basis (invoiced|received), earnedMinor, paidMinor, pendingMinor`

### loans  *(req. 10)*
`type (taken|given), counterparty, principalMinor, interestRate, schedule[],
repayments[], outstandingMinor, status (active|closed)`

### projects  *(req. 12)*
`name, customerId, budgetMinor, startDate, endDate, responsibleIds[], status`

### timeEntries
`projectId, userId, hours, billable (bool), rateMinor, date, invoicedRef?`

---

## Documents & system

### documents  *(req. 15)*
`r2Key, fileName, mimeType, sizeBytes, uploadedBy, link {module, refId}?,
ocr {status, extracted {…}}?, inboxStatus (unmatched|matched)`

### auditLogs  *(req. 19)*
`userId, action, entity {type, id}, before, after, ip, timestamp`  (append-only)

### notifications
`userId, type, payload, readAt`  (also pushed via Socket.IO)

### automationRules  *(req. 17)*
`trigger {event, conditions}, actions[], isActive`

### sequences
`organizationId, key (invoice|customer|vendor…), prefix, nextNumber`  (atomic counters
for human-readable IDs)

---

## Indexing notes

- Compound index `{ organizationId: 1, <naturalKey>: 1 }` on every collection.
- `invoices`: `{organizationId, status, dueDate}` (overdue jobs, aged AR),
  `{organizationId, customerId}`, `{organizationId, salespersonId}`.
- `journalEntries`: `{organizationId, "lines.accountId", date}` for report aggregation.
- `bankTransactions`: `{organizationId, bankAccountId, date}`, `{status}`.
- Text index on customers/vendors/items names + codes for search.
