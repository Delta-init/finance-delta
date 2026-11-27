/**
 * Phase 5 reconciliation and data integrity (2026-11-27), against a scratch database through the real services:
 * matched/unmatched bank lines, a statement difference and its statement check, outstanding deposits and payments,
 * duplicates, transfers, negative/zero-opening/future/out-of-step accounts; PSP collections, charges with VAT,
 * settlements, a delayed and a pending one, a difference and a duplicate; invoice payments against bank lines, missing
 * lines, references, overpayment, balance, void, credit and currency checks; bills and mirrors, vendor credits,
 * duplicate and unreferenced expenses; payroll payments, reversals, a stale run, direct and payroll commission and a
 * typed overlap; advances; migrated records, overlap and opening balances; exceptions once each, by severity; AED and
 * INR apart; figures equal to records; nothing written.
 *
 * Run through scripts/phase-5-reconciliation-e2e.sh. Scratch database only.
 */
export {};

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri) || /:27017\//.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1 (not 27017), got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { CreditNote } = await import("../modules/credit-note/credit-note.model");
const { Bill } = await import("../modules/bill/bill.model");
const { VendorCredit } = await import("../modules/vendor-credit/vendor-credit.model");
const { Expense } = await import("../modules/expense/expense.model");
const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
const { CrmCommissionPayout } = await import("../modules/crm-commission/crm-commission-payout.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { ReconciliationSession } = await import("../modules/banking/reconciliation.model");
const { PspSettlement } = await import("../modules/psp-settlement/psp-settlement.model");
const { syncBillExpense } = await import("../modules/bill/bill-expense");
const rc = await import("../modules/reports/reconciliation.service");
const portal = await import("../modules/integrations/portal-finance-reports.service");
const mongoose = (Organization as any).base;
const { Types } = mongoose;

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(s: string) { console.log(`\n\x1b[1m${s}\x1b[0m`); }
const j = JSON.stringify;
type Side = { currency: string; sections: { key: string; lines: { key: string; amountMinor: number; count: number }[]; totalMinor: number }[]; totals: { key: string; amountMinor: number }[] };
const side = (r: { sides: Side[] }, c = "AED") => r.sides.find((s) => s.currency === c)!;
const tot = (s: Side | undefined, k: string) => s?.totals.find((t) => t.key === k)?.amountMinor;
const ln = (s: Side | undefined, key: string) => s?.sections.flatMap((x) => x.lines).find((l) => l.key === key);
const sec = (s: Side | undefined, key: string) => s?.sections.find((x) => x.key === key)?.totalMinor ?? 0;

await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const now = new Date();
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const O = (await Organization.collection.insertOne({ name: "Test Org", slug: `t-${Date.now()}`, baseCurrency: "AED", currency: "AED", createdAt: now, updatedAt: now })).insertedId;
const org = String(O);
const U = new Types.ObjectId(), customerId = new Types.ObjectId(), vendorId = new Types.ObjectId();
const P = ["2026-10-01", "2026-11-30"] as const;

try {
  step("Setting up");
  const acct = async (name: string, type: string, currency: string, opening: number, openingDate: string, extra: Record<string, unknown> = {}) =>
    (await BankAccount.collection.insertOne({ organizationId: O, accountName: name, accountType: type, currency, openingBalanceMinor: opening, openingDate: d(openingDate), currentBalanceMinor: 0, isActive: true, createdAt: now, updatedAt: now, ...extra })).insertedId;
  const MAIN = await acct("Main", "current", "AED", 50_000_00, "2026-09-01");
  const SAV = await acct("Savings", "savings", "AED", 0, "2026-09-01");
  const NEG = await acct("Short", "current", "AED", 0, "2026-09-01");
  const PSP = await acct("Gateway", "psp", "AED", 0, "2026-09-01", { psp: { provider: "Gateway", feeVatPct: 5, settlementAccountId: MAIN, settlementDays: 7, startDate: d("2026-09-01") } });
  const INR = await acct("Rupee", "current", "INR", 10_000_00, "2026-09-01");

  // Invoices (live and old books)
  const inv = async (n: string, total: number, issue: string, pays: { a: number; on: string; ref?: string; line?: unknown; acc?: unknown; bankCurrency?: string }[], extra: Record<string, unknown> = {}) => {
    const paid = pays.reduce((x, p) => x + p.a, 0);
    const doc = { organizationId: O, invoiceNumber: n, customerId, customerName: `Client ${n}`, salespersonName: "Sales", status: paid >= total ? "paid" : paid ? "partial" : "sent", currency: "AED", issueDate: d(issue), dueDate: d(issue), lineItems: [], subtotalMinor: total, taxTotalMinor: 0, totalMinor: total, amountPaidMinor: paid, balanceMinor: total - paid,
      payments: pays.map((p) => ({ _id: new Types.ObjectId(), method: "bank_transfer", amountMinor: p.a, paidOn: d(p.on), reference: p.ref ?? "", bankAccountId: p.acc ?? null, bankTransactionId: p.line ?? null, ...(p.bankCurrency ? { bankCurrency: p.bankCurrency } : {}) })), exchangeRate: 1, baseTotalMinor: total, createdAt: now, updatedAt: now, ...extra };
    return (await Invoice.collection.insertOne(doc)).insertedId;
  };
  const L1 = new Types.ObjectId(), LPSP = new Types.ObjectId(), LGONE = new Types.ObjectId(), LSTRAY = new Types.ObjectId();
  const iGood = await inv("I-GOOD", 10_000_00, "2026-10-05", [{ a: 10_000_00, on: "2026-10-06", ref: "TRX-1", line: L1, acc: MAIN }]);
  await inv("I-PSP", 4_000_00, "2026-10-07", [{ a: 4_000_00, on: "2026-10-08", ref: "TRX-2", line: LPSP, acc: PSP }]);
  await inv("I-NOBANK", 2_000_00, "2026-10-09", [{ a: 2_000_00, on: "2026-10-10", ref: "TRX-3" }]);
  await inv("I-GONE", 1_500_00, "2026-10-11", [{ a: 1_500_00, on: "2026-10-12", ref: "TRX-4", line: LGONE, acc: MAIN }]);
  await inv("I-DUPREF-A", 700_00, "2026-10-13", [{ a: 700_00, on: "2026-10-14", ref: "SAME-REF", acc: MAIN }]);
  await inv("I-DUPREF-B", 700_00, "2026-10-15", [{ a: 700_00, on: "2026-10-16", ref: "same-ref", acc: MAIN }]);
  await inv("I-OVER", 1_000_00, "2026-10-17", [{ a: 1_200_00, on: "2026-10-18", ref: "TRX-5", acc: MAIN }], { balanceMinor: -200_00, status: "paid" });
  await inv("I-BAL", 3_000_00, "2026-10-19", [], { balanceMinor: 2_500_00 });
  await inv("I-VOID", 900_00, "2026-10-20", [{ a: 900_00, on: "2026-10-21", ref: "TRX-6", acc: MAIN }], { status: "void" });
  const iCr = await inv("I-CREDIT", 5_000_00, "2026-10-22", [], { amountPaidMinor: 500_00, balanceMinor: 4_500_00, status: "partial" }); // 500 settled beyond payments, no credit note
  await inv("I-CUR", 800_00, "2026-10-23", [{ a: 800_00, on: "2026-10-24", ref: "TRX-7", acc: INR, bankCurrency: "INR" }]);
  for (let k = 0; k < 25; k++) await inv(`OB-${k}`, 100_00, "2025-03-01", [{ a: 100_00, on: "2025-03-02", ref: "IMPORTED" }], { external: { source: "old_books" } });
  await inv("OB-OPEN", 3_000_00, "2025-04-01", [], { external: { source: "old_books" } });
  void iGood; void iCr;
  await CreditNote.collection.insertOne({ organizationId: O, creditNoteNumber: "CN-OK", invoiceId: new Types.ObjectId(), invoiceNumber: "X", customerId, customerName: "C", reason: "r", status: "issued", lineItems: [], subtotalMinor: 1, taxTotalMinor: 0, totalMinor: 1, amountAppliedMinor: 0, currency: "AED", issuedAt: now, createdAt: now, updatedAt: now });

  // Bank lines
  const bl = (id: unknown, acc: unknown, on: string, amount: number, extra: Record<string, unknown> = {}) => ({ _id: id ?? new Types.ObjectId(), organizationId: O, accountId: acc, accountName: "x", currency: acc === INR ? "INR" : "AED", date: d(on), description: "line", reference: "", amountMinor: amount, type: amount > 0 ? "credit" : "debit", runningBalanceMinor: 0, source: "manual", status: "matched", matches: [], transfer: null, settlement: null, isReconciled: false, createdAt: now, updatedAt: now, ...extra });
  const m = (type: string, n: string, a: number) => ({ matches: [{ type, referenceId: String(new Types.ObjectId()), referenceNumber: n, amountMinor: Math.abs(a) }] });
  const T1 = new Types.ObjectId(), ST = new Types.ObjectId();
  const PSP2 = new Types.ObjectId(), PSPOLD = new Types.ObjectId();
  await BankTransaction.collection.insertMany([
    bl(L1, MAIN, "2026-10-06", 10_000_00, { ...m("invoice", "I-GOOD", 10_000_00), isReconciled: true }),
    bl(LSTRAY, MAIN, "2026-10-25", 600_00, m("invoice", "I-STRAY", 600_00)),                 // matched to an invoice no payment points to
    bl(null, MAIN, "2026-10-26", 2_500_00, { status: "unmatched" }),                         // unmatched in
    bl(null, MAIN, "2026-10-27", -1_800_00, { status: "unmatched" }),                        // unmatched out
    bl(null, MAIN, "2026-10-28", -300_00, { status: "duplicate" }),                          // marked duplicate
    bl(null, MAIN, "2026-10-29", -5_000_00, { transfer: { id: T1, otherAccountId: SAV, otherAccountName: "Savings", otherTransactionId: new Types.ObjectId(), otherAmountMinor: 5_000_00, otherCurrency: "AED" } }),
    bl(null, SAV, "2026-10-29", 5_000_00, { transfer: { id: T1, otherAccountId: MAIN, otherAccountName: "Main", otherTransactionId: new Types.ObjectId(), otherAmountMinor: 5_000_00, otherCurrency: "AED" } }),
    bl(null, NEG, "2026-10-30", -400_00, m("expense", "EXP-X", 400_00)),                    // account below zero
    bl(LPSP, PSP, "2026-10-08", 4_000_00, { ...m("invoice", "I-PSP", 4_000_00), settlement: { id: ST, number: "PSP-1" } }),
    bl(PSP2, PSP, "2026-10-09", 1_000_00, { ...m("invoice", "I-PSP2", 1_000_00), settlement: { id: ST, number: "PSP-1" } }),
    bl(null, PSP, "2026-10-20", -4_790_00, { transfer: { id: new Types.ObjectId(), otherAccountId: MAIN, otherAccountName: "Main", otherTransactionId: new Types.ObjectId(), otherAmountMinor: 4_790_00, otherCurrency: "AED" }, settlement: { id: ST, number: "PSP-1" } }),
    bl(null, MAIN, "2026-10-20", 4_790_00, { transfer: { id: new Types.ObjectId(), otherAccountId: PSP, otherAccountName: "Gateway", otherTransactionId: new Types.ObjectId(), otherAmountMinor: 4_790_00, otherCurrency: "AED" }, settlement: { id: ST, number: "PSP-1" } }),
    bl(null, PSP, "2026-10-20", -210_00, { ...m("expense", "EXP-FEE", 210_00), settlement: { id: ST, number: "PSP-1" } }),
    bl(PSPOLD, PSP, "2026-11-01", 2_000_00, m("invoice", "I-PSP3", 2_000_00)),               // pending, beyond the 7-day cycle by 30 Nov
    bl(null, INR, "2026-12-15", -100_00, { status: "unmatched" }),                           // dated in the future
  ]);
  for (const id of [MAIN, SAV, NEG, PSP, INR]) {
    const a: any = await BankAccount.collection.findOne({ _id: id });
    const sum = (await BankTransaction.collection.find({ accountId: id }).toArray()).reduce((n: number, l: any) => n + l.amountMinor, 0);
    await BankAccount.collection.updateOne({ _id: id }, { $set: { currentBalanceMinor: a.openingBalanceMinor + sum + (id === SAV ? 1_00 : 0) } }); // Savings stored 1.00 out of step
  }
  // A reconciliation session on Main: statement 31 Oct, a difference, a statement check.
  await ReconciliationSession.collection.insertOne({ organizationId: O, accountId: MAIN, accountName: "Main", currency: "AED", statementDate: d("2026-10-31"), periodFrom: d("2026-10-01"), periodTo: d("2026-10-31"), statementBalanceMinor: 60_000_00, openingBookBalanceMinor: 50_000_00, closingBookBalanceMinor: 59_790_00, differenceMinor: 210_00, status: "open", reconciledTransactionIds: [L1], statementDates: {},
    statementCheck: { checkedAt: now.toISOString(), fileName: "oct.csv", windowDays: 3, lines: [{ index: 0, date: "2026-10-06", description: "deposit", reference: "", amountMinor: 10_000_00, status: "matched", bookLines: [] }, { index: 1, date: "2026-10-30", description: "bank charge", reference: "BC", amountMinor: -210_00, status: "not_in_books", bookLines: [] }], notOnStatement: [{ id: String(new Types.ObjectId()), date: "2026-10-27", description: "line", reference: "", amountMinor: -1_800_00 }], summary: { statementLines: 2, matched: 1, amountDiffers: 0, notInBooks: 1, notOnStatement: 1, inMinor: 10_000_00, outMinor: 210_00, unexplainedMinor: 0, fileClosingMinor: null, closingAgrees: null }, allMatch: false },
    createdAt: now, updatedAt: now });
  // PSP settlements: one consistent (with a 12-day delay); one whose gross differs from its lines; a duplicate.
  await PspSettlement.collection.insertMany([
    { organizationId: O, number: "PSP-1", date: d("2026-10-20"), pspAccountId: PSP, pspAccountName: "Gateway", bankAccountId: MAIN, bankAccountName: "Main", currency: "AED", lineIds: [LPSP, PSP2], grossMinor: 5_000_00, receivedMinor: 4_790_00, feeMinor: 210_00, expectedFeeMinor: 0, transferId: new Types.ObjectId(), createdAt: now, updatedAt: now },
    { organizationId: O, number: "PSP-2", date: d("2026-11-10"), pspAccountId: PSP, pspAccountName: "Gateway", bankAccountId: MAIN, bankAccountName: "Main", currency: "AED", lineIds: [], grossMinor: 3_000_00, receivedMinor: 2_900_00, feeMinor: 100_00, expectedFeeMinor: 0, transferId: null, createdAt: now, updatedAt: now },
    { organizationId: O, number: "PSP-3", date: d("2026-11-10"), pspAccountId: PSP, pspAccountName: "Gateway", bankAccountId: MAIN, bankAccountName: "Main", currency: "AED", lineIds: [], grossMinor: 3_000_00, receivedMinor: 2_900_00, feeMinor: 100_00, expectedFeeMinor: 0, transferId: new Types.ObjectId(), createdAt: now, updatedAt: now },
  ]);

  // Bills, vendor credits, expenses
  const billNoMirror = (await Bill.collection.insertOne({ organizationId: O, billNumber: "BILL-NM", vendorId, vendorName: "Supplier", billDate: d("2026-10-05"), dueDate: d("2026-11-05"), status: "approved", currency: "AED", lineItems: [], subtotalMinor: 1_000_00, taxTotalMinor: 50_00, totalMinor: 1_050_00, amountPaidMinor: 0, balanceMinor: 1_050_00, payments: [], createdAt: now, updatedAt: now })).insertedId;
  void billNoMirror;
  const billOk = (await Bill.collection.insertOne({ organizationId: O, billNumber: "BILL-OK", vendorId, vendorName: "Supplier", billDate: d("2026-10-06"), dueDate: d("2026-11-06"), status: "partially_paid", currency: "AED", lineItems: [], subtotalMinor: 2_000_00, taxTotalMinor: 100_00, totalMinor: 2_100_00, amountPaidMinor: 1_000_00, balanceMinor: 1_100_00, payments: [{ _id: new Types.ObjectId(), amountMinor: 1_000_00, paidOn: d("2026-10-20"), reference: "B1", bankTransactionId: null }], createdAt: now, updatedAt: now })).insertedId;
  await syncBillExpense(org, billOk);
  await VendorCredit.collection.insertOne({ organizationId: O, creditNumber: "VC-1", vendorId, vendorName: "Supplier", issueDate: d("2026-10-25"), status: "issued", currency: "AED", lineItems: [], subtotalMinor: 300_00, taxTotalMinor: 0, totalMinor: 300_00, amountAppliedMinor: 0, createdAt: now, updatedAt: now });
  const exp = (n: string, category: string, amount: number, on: string, extra: Record<string, unknown> = {}) => ({ organizationId: O, expenseNumber: n, category, subcategory: null, description: n, expenseDate: d(on), paidOn: d(on), amountMinor: amount, taxMinor: 0, totalMinor: amount, currency: "AED", status: "approved", paymentMethod: "bank_transfer", reference: "R", bankTransactionId: new Types.ObjectId(), createdAt: now, updatedAt: now, ...extra });
  await Expense.collection.insertMany([
    exp("EXP-D1", "software_it", 450_00, "2026-10-10"), exp("EXP-D2", "software_it", 450_00, "2026-10-10"),           // duplicates
    exp("EXP-NOLINE", "rent_utilities", 6_000_00, "2026-10-11", { bankTransactionId: null }),                       // paid, no bank line
    exp("EXP-NOREF", "advertising_marketing", 800_00, "2026-10-12", { reference: "" }),                             // no reference
    exp("EXP-VAT", "office_supplies", 105_00, "2026-10-13", { taxMinor: 5_00 }),
    exp("EXP-VATCTRL", "vat_control", 8_000_00, "2026-11-05"),                                                      // balance-sheet-like
    exp("EXP-COM", "sales_commission", 1_200_00, "2026-10-28", { description: "Commission for Rep October" }),      // typed commission naming the payee
    exp("EXP-LIVE", "rent_utilities", 777_00, "2026-10-15"),                                                        // live …
    exp("EXP-IMP", "rent_utilities", 777_00, "2026-10-15", { source: { kind: "import" }, bankTransactionId: null }), // … and an import of the same: possible double count
    exp("EXP-IMP-OLD", "rent_utilities", 999_00, "2025-05-01", { source: { kind: "import" }, bankTransactionId: null }),
    exp("EXP-ADV-OLD", "employee_advances", 4_000_00, "2025-06-01", { source: { kind: "import" }, bankTransactionId: null }),
  ]);

  // Payroll and commission
  const lA = new Types.ObjectId(), lB = new Types.ObjectId();
  const pl = (id: unknown, name: string, emp: string, payable: number, paid: number, deductions: { label: string; amountMinor: number }[] = [], status = "pending") => ({ _id: id, hrmsPayslipId: `P-${name}`, hrmsEmployeeId: emp, employeeCode: name, name, earnings: [], deductions, grossMinor: payable, deductionsMinor: 0, netFromHrmsMinor: payable, adjustmentsMinor: 0, payableMinor: payable, amountPaidMinor: paid, payable: true, status });
  await PayrollRun.collection.insertMany([
    { organizationId: O, source: "hrms", hrmsOrgId: "H", runNumber: "PAY-OCT", period: "2026-10", currency: "AED", status: "partially_paid", lines: [pl(lA, "A", "E-A", 30_000_00, 30_000_00, [{ label: "Salary advance", amountMinor: 1_000_00 }, { label: "Loan repayment (Visa loan)", amountMinor: 200_00 }]), pl(lB, "B", "E-B", 10_000_00, 0)], adjustments: [],
      payments: [{ _id: new Types.ObjectId(), paymentId: "p1", method: "bank_transfer", paidOn: d("2026-11-03"), amountMinor: 30_000_00, currency: "AED", allocations: [{ lineId: lA, amountMinor: 30_000_00 }], bankTransactionId: new Types.ObjectId() },
        { _id: new Types.ObjectId(), paymentId: "p2", method: "bank_transfer", paidOn: d("2026-11-03"), amountMinor: 500_00, currency: "AED", allocations: [{ lineId: lB, amountMinor: 500_00 }], reversedAt: d("2026-11-04") }], createdAt: now, updatedAt: now },
    { organizationId: O, source: "hrms", hrmsOrgId: "H2", runNumber: "PAY-AUG", period: "2026-08", currency: "AED", status: "approved", lines: [pl(new Types.ObjectId(), "C", "E-C", 5_000_00, 0, [], "on_hold")], adjustments: [], payments: [], createdAt: now, updatedAt: now },
  ]);
  const payout = (amount: number, state: string, extra: Record<string, unknown> = {}) => ({ _id: new Types.ObjectId(), key: `k-${Math.random()}`, organizationId: O, crm: "sales", crmName: "Sales", month: "2026-10", userId: "u", personName: "Rep One", currency: "AED", amountMinor: amount, state, approvedById: U, approvedAt: d("2026-11-01"), createdAt: now, updatedAt: now, ...extra });
  await CrmCommissionPayout.collection.insertMany([payout(2_000_00, "approved"), payout(3_000_00, "paid", { payrollRunId: new Types.ObjectId() }), payout(1_000_00, "paid", { expenseId: new Types.ObjectId(), paidOn: d("2026-11-02") })]);

  // ── Bank ───────────────────────────────────────────────────────────────────
  step("Bank reconciliation");
  const bank = await rc.reconciliationReport(org, "bank", ...P);
  const b = side(bank as any);
  check("statement difference 210 on Main (statement 60,000 vs system 59,790), open", ln(b, "differences:" + String(MAIN))?.amountMinor === 210_00, j(b.sections.find((s) => s.key === "differences")));
  check("statement line missing from finance: the bank charge −210", ln(b, "not_in_books:not_in_books")?.amountMinor === -210_00);
  check("finance line missing from the statement: −1,800", ln(b, "not_on_statement:out")?.amountMinor === -1_800_00);
  check("outstanding up to 31 Oct: deposits (unticked money in) and payments (unticked money out), transfers left out", (ln(b, "outstanding:deposits")?.amountMinor ?? 0) > 0 && (ln(b, "outstanding:payments")?.amountMinor ?? 0) < 0 && !bank.rows.some((r) => r.section === "outstanding" && /transfer/.test(r.detail)), j(b.sections.find((s) => s.key === "outstanding")));
  check("unmatched: in 2,500, out −1,800 (the duplicate and transfers not here)", ln(b, "unmatched:in")?.amountMinor === 2_500_00 && ln(b, "unmatched:out")?.amountMinor === -1_800_00 && ln(b, "unmatched:in")?.count === 1, j(b.sections.find((s) => s.key === "unmatched")));
  check("marked duplicate −300 flagged", ln(b, "flags:duplicate")?.amountMinor === -300_00);
  check("below zero (Short −400), opening 0 not verified, never reconciled, stored balance out of step (Savings +1.00)", ln(b, "flags:negative")?.amountMinor === -400_00 && (ln(b, "flags:zero_opening")?.count ?? 0) >= 2 && (ln(b, "flags:never_reconciled")?.count ?? 0) >= 1 && ln(b, "flags:drift")?.amountMinor === 1_00, j(b.sections.find((s) => s.key === "flags")));
  check("a correct running balance is not 'reconciled': Main shows 'Not reconciled' (session open)", bank.rows.find((r) => r.id === `acct:${MAIN}`)?.status === "Not reconciled");
  check("future-dated INR line flagged on the INR side", (ln(side(bank as any, "INR"), "flags:future")?.count ?? 0) === 1);

  // ── PSP ────────────────────────────────────────────────────────────────────
  step("PSP and settlements");
  const psp = await rc.reconciliationReport(org, "psp", ...P);
  const p = side(psp as any);
  check("collected through the gateway 7,000 (4,000 + 1,000 + 2,000), transfers out", tot(p, "collected") === 7_000_00, j(p.totals));
  check("charges 410 (210 + 100 + 100); VAT on charges at 5% shown", tot(p, "fees") === 410_00 && sec(p, "fee_vat") === Math.round(210_00 - 210_00 / 1.05) + 2 * Math.round(100_00 - 100_00 / 1.05));
  check("settled to the bank 10,590 (4,790 + 2,900 + 2,900)", tot(p, "settled") === 10_590_00);
  check("pending 2,000 (beyond the 7-day cycle, flagged)", tot(p, "pending") === 2_000_00 && psp.rows.some((r) => r.section === "pending" && r.severity === "medium"));
  check("delay 12 days on PSP-1 (oldest payment 8 Oct, settled 20 Oct)", psp.rows.some((r) => r.id.startsWith("delay:") && r.status === "12 days"));
  check("differences: PSP-2 gross 3,000 ≠ its lines (0) and no transfer; PSP-3 gross ≠ lines", psp.rows.filter((r) => r.section === "differences").length === 3, j(psp.rows.filter((r) => r.section === "differences").map((r) => [r.title, r.category])));
  check("possible duplicate settlements: PSP-2 and PSP-3 (same gross, same day)", psp.rows.filter((r) => r.section === "duplicates").length === 2);

  // ── Invoices ───────────────────────────────────────────────────────────────
  step("Invoices and collections");
  const iv = await rc.reconciliationReport(org, "invoices", ...P);
  const i = side(iv as any);
  check("payment linked to a deleted bank line (I-GONE 1,500): high", ln(i, "payments:missing_line")?.amountMinor === 1_500_00 && iv.rows.some((r) => r.number === "TRX-4" && r.severity === "high"));
  check("payments without a bank line: no account 2,000 (I-NOBANK); account chosen, no line 4,300 (dup refs 1,400 + over 1,200 + cur 800 + void… not void)", ln(i, "payments:no_bank")?.amountMinor === 2_000_00, j(i.sections.find((s) => s.key === "payments")));
  check("bank receipts with no payment pointing back: 3,600 (I-STRAY 600 + gateway lines 1,000 and 2,000 whose invoices have no payment)", ln(i, "bank_side:unpointed")?.amountMinor === 3_600_00 && ln(i, "bank_side:unpointed")?.count === 3, j(ln(i, "bank_side:unpointed")));
  check("duplicate reference SAME-REF (case-insensitive) twice; the placeholder IMPORTED (25 old-books uses) not flagged", ln(i, "references:duplicate")?.count === 2 && !iv.rows.some((r) => /IMPORTED/i.test(r.detail)));
  check("overpaid (200), balance wrong (500), void with payments (900), credit without a credit note (500): critical/high", ln(i, "integrity:overpaid")?.amountMinor === 200_00 && ln(i, "integrity:balance")?.amountMinor === -500_00 && ln(i, "integrity:void_paid")?.amountMinor === 900_00 && ln(i, "integrity:credit")?.amountMinor === 500_00, j(i.sections.find((s) => s.key === "integrity")));
  check("currency mismatch: paid into the INR account, rupee amount not recorded", ln(i, "currency:mismatch")?.count === 1);
  check("old-books payments are not here (migrated)", !iv.rows.some((r) => r.number?.startsWith("OB-")));

  // ── Expenses ───────────────────────────────────────────────────────────────
  step("Expenses and suppliers");
  const ex = await rc.reconciliationReport(org, "expenses", ...P);
  const e = side(ex as any);
  check("bill without its mirror (BILL-NM); BILL-OK's mirror fine", ln(e, "bills:no_mirror")?.count === 1 && !ex.rows.some((r) => r.number === "BILL-OK" && r.line === "no_mirror"));
  check("supplier payment without a bank line (BILL-OK 1,000)", ln(e, "bills:payment_no_line")?.amountMinor === 1_000_00);
  check("vendor credit not used: 300", ln(e, "vendor_credits:unapplied")?.amountMinor === 300_00);
  check("possible duplicate: the second of EXP-D1/EXP-D2 (450)", ln(e, "duplicates:possible")?.amountMinor === 450_00 && ln(e, "duplicates:possible")?.count === 1);
  check("paid without a bank line: 6,000; missing reference: 800", ln(e, "no_bank:paid_no_line")?.amountMinor === 6_000_00 && ln(e, "references:missing")?.amountMinor === 800_00);
  check("expense VAT 5 shown; VAT Control 8,000 in November as a balance-sheet-like category", ln(e, "vat:expense_vat")?.amountMinor === 5_00 && ln(e, "classification:vat_control")?.amountMinor === 8_000_00);

  // ── Payroll ────────────────────────────────────────────────────────────────
  step("Payroll and commission");
  const pr = await rc.reconciliationReport(org, "payroll", ...P);
  const y = side(pr as any);
  check("October obligation 40,000; outstanding 10,000", ln(y, "obligation:payable")?.amountMinor === 40_000_00 && ln(y, "obligation:outstanding")?.amountMinor === 10_000_00, j(y.sections.find((s) => s.key === "obligation")));
  check("payments 30,500, reversal −500 → paid net 30,000", ln(y, "payments:paid")?.amountMinor === 30_500_00 && ln(y, "payments:reversed")?.amountMinor === -500_00 && tot(y, "paid") === 30_000_00);
  check("payment whose bank line is gone flagged (high)", ln(y, "exceptions:payment_no_line")?.count === 1);
  check("salary advance deduction 1,000; visa loan 200 apart", ln(y, "deductions:salary_advance")?.amountMinor === 1_000_00 && ln(y, "deductions:other_loan")?.amountMinor === 200_00);
  check("commission: approved unpaid 2,000; in payroll 3,000; paid directly 1,000", ln(y, "commission:approved_unpaid")?.amountMinor === 2_000_00 && ln(y, "commission:in_payroll")?.amountMinor === 3_000_00 && ln(y, "commission:paid_direct")?.amountMinor === 1_000_00);
  check("typed commission naming Rep (who has payouts in October): possible overlap, high", ln(y, "overlap:named")?.amountMinor === 1_200_00 && pr.rows.some((r) => r.section === "overlap" && r.severity === "high"));
  const prAug = await rc.reconciliationReport(org, "payroll", "2026-08-01", "2026-11-30");
  check("the August run approved and never paid: flagged (high, suspected)", prAug.rows.some((r) => r.line === "stale_run" && r.number === "PAY-AUG" && r.severity === "high" && r.confidence === "suspected"));

  // ── Advances ───────────────────────────────────────────────────────────────
  step("Employee advances");
  const ad = await rc.reconciliationReport(org, "advances", ...P);
  check("recovery 1,000 with no advance in finance: own section, flagged", ad.rows.some((r) => r.section === "earlier" && r.severity === "medium"));
  check("old-books advance 4,000: one exception (not estimated)", ad.rows.filter((r) => r.line === "unknown").length === 1 && ad.rows.find((r) => r.line === "unknown")?.amountMinor === 4_000_00);
  check("HRMS not reachable: said so", ad.warnings.some((w) => /HRMS/.test(w)));

  // ── Historical ─────────────────────────────────────────────────────────────
  step("Historical data");
  const hi = await rc.reconciliationReport(org, "historical", ...P);
  const h = side(hi as any);
  check("old books: 26 invoices; 25 migrated payments (no bank record expected); receivable 3,000", ln(h, "old_books:invoices")?.count === 26 && ln(h, "old_books:payments")?.count === 25 && ln(h, "old_books:receivables")?.amountMinor === 3_000_00 && hi.rows.every((r) => r.line !== "payments" || r.status === "Migrated, no bank record expected"));
  check("migrated expenses and a historical advance apart", ln(h, "old_books:expenses")?.count === 2 && ln(h, "old_books:advances")?.amountMinor === 4_000_00);
  check("import matching a live expense (777 on 15 Oct): possible double count, high", ln(h, "discrepancies:overlap")?.amountMinor === 777_00 && hi.rows.some((r) => r.line === "overlap" && r.severity === "high"));
  check("old imports without a bank record are not discrepancies", !hi.rows.some((r) => r.section === "discrepancies" && r.number === "EXP-IMP-OLD"));
  check("opening balances: none verified (no completed reconciliation)", (ln(h, "opening:unverified")?.count ?? 0) >= 4 && !ln(h, "opening:verified"));
  check(`live invoices split at the cutover ${rc.CUTOVER}`, (ln(h, "live:before_cutover")?.count ?? 0) > 0);

  // ── Exceptions and summary ─────────────────────────────────────────────────
  step("Exceptions and the dashboard summary");
  const exc = await rc.reconciliationReport(org, "exceptions", ...P);
  const ids = exc.rows.map((r) => r.id);
  check("each exception once (no repeated record)", new Set(ids).size === ids.length);
  check("critical: overpaid, wrong balance, stored balance out of step", exc.rows.filter((r) => r.severity === "critical").length === 3, j(exc.rows.filter((r) => r.severity === "critical").map((r) => r.exception)));
  check("each carries type, module, severity, status, action, age, link", exc.rows.every((r) => r.exception && r.module && r.severity && r.status && r.action && typeof r.ageDays === "number" && r.href !== undefined));
  check("confirmed, suspected and missing information told apart", ["confirmed", "suspected", "missing"].every((c) => exc.rows.some((r) => r.confidence === c)));
  check("INR exceptions on their own side", exc.rows.some((r) => r.currency === "INR") && side(exc as any, "INR") !== undefined);
  const sum = await rc.reconciliationReport(org, "summary", ...P);
  const ind = (k: string, c = "AED") => sum.indicators.find((x) => x.key === k && x.currency === c)?.value;
  check("summary: 4 AED accounts, none reconciled", ind("accounts") === 4 && ind("reconciled") === 0 && ind("unreconciled") === 4, j(sum.indicators.filter((x) => x.currency === "AED")));
  check("summary = the reports: differences 210, unmatched in 2,500 / out −1,800, PSP pending 2,000", ind("differences") === 210_00 && ind("unmatched_in") === 2_500_00 && ind("unmatched_out") === -1_800_00 && ind("psp_pending") === 2_000_00);
  check("summary: open exceptions = the exception list; critical + high counted", ind("open") === exc.rows.filter((r) => r.currency === "AED").length && ind("critical_high") === exc.rows.filter((r) => r.currency === "AED" && (r.severity === "critical" || r.severity === "high")).length);
  check("records add up: bank unmatched section = its records", rc.rcLinesOf(bank.rows, "unmatched").filter((r) => r.currency === "AED").reduce((n, r) => n + r.amountMinor, 0) === sec(b, "unmatched"));

  step("Root's feed");
  const root = await portal.reconciliationForPortal({ org, from: P[0], to: P[1], report: "summary" }) as any;
  check("Root gets the indicators, without the records", typeof root === "object" && !("rows" in root) && root.indicators.length >= 13);
  const rl = await portal.reconciliationLinesForPortal({ org, from: P[0], to: P[1], report: "exceptions", line: "all", severityName: "Critical" }) as any;
  check("Root can filter exceptions by severity", typeof rl === "object" && rl.totals.count === 3, j(rl.totals));

  step("Nothing written");
  const main: any = await BankAccount.collection.findOne({ _id: SAV });
  check("balances, lines, sessions and records unchanged", main.currentBalanceMinor === 5_001_00 && (await BankTransaction.collection.countDocuments({ organizationId: O })) === 15 && (await ReconciliationSession.collection.findOne({ organizationId: O }))!.status === "open");
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? `, ${failures} failed` : ""}`);
process.exit(failures ? 1 : 0);
