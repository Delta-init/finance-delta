/**
 * Phase 4 cash flow and financial position (2026-11-27), against a scratch database through the real services:
 * opening + movement = closing; transfers out of money in/out but in balances; payroll incurred in October, paid in
 * November, a payment reversed; part supplier payments; a customer paying an older invoice; receivables before and after
 * payment; a credit note applied later; a vendor credit; unpaid salary and commission; an advance and its recovery; a
 * PSP payment settled without counting the money twice; a loan received and repaid; duplicate and unmatched lines;
 * AED and INR apart; every figure equal to its records; nothing written.
 *
 * Run through scripts/phase-4-financial-position-e2e.sh. Scratch database only.
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
const { Expense } = await import("../modules/expense/expense.model");
const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
const { CrmCommissionPayout } = await import("../modules/crm-commission/crm-commission-payout.model");
const { CommissionRecord } = await import("../modules/commission/commission-record.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { Loan } = await import("../modules/loan/loan.model");
const { LoanRepayment } = await import("../modules/loan/loan-repayment.model");
const fp = await import("../modules/reports/financial-position.service");
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
const line = (s: Side | undefined, key: string) => s?.sections.flatMap((x) => x.lines).find((l) => l.key === key)?.amountMinor ?? 0;
const sec = (s: Side | undefined, key: string) => s?.sections.find((x) => x.key === key)?.totalMinor ?? 0;

await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const now = new Date();
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const O = (await Organization.collection.insertOne({ name: "Test Org", slug: `t-${Date.now()}`, baseCurrency: "AED", currency: "AED", createdAt: now, updatedAt: now })).insertedId;
const org = String(O);
const U = new Types.ObjectId(), customerId = new Types.ObjectId(), vendorId = new Types.ObjectId();
const PERIOD = ["2026-10-01", "2026-11-30"] as const;

try {
  step("Setting up");
  const acct = async (name: string, type: string, currency: string, opening: number, openingDate: string, extra: Record<string, unknown> = {}) =>
    (await BankAccount.collection.insertOne({ organizationId: O, accountName: name, accountType: type, currency, openingBalanceMinor: opening, openingDate: d(openingDate), currentBalanceMinor: 0, isActive: true, createdAt: now, updatedAt: now, ...extra })).insertedId;
  const MAIN = await acct("Main", "current", "AED", 10_000_00, "2026-09-01");
  const SAV = await acct("Savings", "savings", "AED", 0, "2026-09-01");
  const PETTY = await acct("Petty", "petty_cash", "AED", 500_00, "2026-10-15");
  const PSP = await acct("Gateway", "psp", "AED", 0, "2026-09-01", { psp: { provider: "Gateway", feeVatPct: 0, settlementAccountId: MAIN, settlementDays: 7, startDate: d("2026-09-01") } });
  const INR = await acct("Rupee", "current", "INR", 0, "2026-09-01");

  // Expenses the bank lines are matched to (the category decides the activity).
  const exp = async (n: string, category: string, subcategory: string | null, amount: number, expenseDate: string, paidOn: string | null, extra: Record<string, unknown> = {}) =>
    (await Expense.collection.insertOne({ organizationId: O, expenseNumber: n, category, subcategory, description: n, expenseDate: d(expenseDate), paidOn: paidOn ? d(paidOn) : null, amountMinor: amount, taxMinor: 0, totalMinor: amount, currency: "AED", status: "approved", createdAt: now, updatedAt: now, ...extra })).insertedId;
  const eRent = await exp("EXP-RENT", "rent_utilities", "office_rent", 20_000_00, "2026-10-10", "2026-10-10");
  const eCom = await exp("EXP-COM", "sales_commission", "sales_commission", 1_000_00, "2026-11-05", "2026-11-05");
  const eFee = await exp("EXP-FEE", "bank_fees", "payment_gateway_fees", 500_00, "2026-11-12", "2026-11-12");
  const eComp = await exp("EXP-PC", "office_setup", "computers", 5_000_00, "2026-11-15", "2026-11-15");
  await exp("EXP-OWED", "software_it", null, 3_000_00, "2026-10-22", null);
  await exp("EXP-PAIDLATER", "software_it", null, 2_000_00, "2026-10-25", "2026-11-01");
  await exp("EXP-ADV", "employee_advances", "salary_advances", 5_000_00, "2026-10-02", "2026-10-02", { source: { kind: "hrms_advance", key: "hrms-advance:H:A1" }, notes: "Salary advance approved from HRMS.\nEmployee: A (E1)" });
  await exp("EXP-ADV-OLD", "employee_advances", "salary_advances", 7_000_00, "2025-06-01", "2025-06-01", { source: { kind: "import" } });

  const T1 = new Types.ObjectId(), T2 = new Types.ObjectId();
  const bl = (acc: unknown, on: string, amount: number, extra: Record<string, unknown> = {}) => ({ organizationId: O, accountId: acc, accountName: "x", currency: acc === INR ? "INR" : "AED", date: d(on), description: "line", amountMinor: amount, type: amount > 0 ? "credit" : "debit", runningBalanceMinor: 0, source: "manual", status: "matched", matches: [], transfer: null, settlement: null, createdAt: now, updatedAt: now, ...extra });
  const m = (type: string, id: unknown, n: string, a: number) => ({ matches: [{ type, referenceId: String(id), referenceNumber: n, amountMinor: Math.abs(a) }] });
  await BankTransaction.collection.insertMany([
    bl(MAIN, "2026-09-15", 5_000_00, m("invoice", new Types.ObjectId(), "INV-SEP", 5_000_00)),             // before the period
    bl(MAIN, "2026-10-05", 42_000_00, m("invoice", new Types.ObjectId(), "INV-OLD", 42_000_00)),            // an older invoice paid
    bl(MAIN, "2026-10-10", -20_000_00, m("expense", eRent, "EXP-RENT", 20_000_00)),
    bl(MAIN, "2026-10-12", -30_000_00, { transfer: { id: T1, otherAccountId: SAV, otherAccountName: "Savings", otherTransactionId: new Types.ObjectId(), otherAmountMinor: 30_000_00, otherCurrency: "AED" } }),
    bl(SAV, "2026-10-12", 30_000_00, { transfer: { id: T1, otherAccountId: MAIN, otherAccountName: "Main", otherTransactionId: new Types.ObjectId(), otherAmountMinor: 30_000_00, otherCurrency: "AED" } }),
    bl(PSP, "2026-10-20", 10_000_00, m("invoice", new Types.ObjectId(), "INV-PSP", 10_000_00)),             // paid through the gateway
    bl(MAIN, "2026-11-03", -300_000_00, m("payroll", new Types.ObjectId(), "PAY-OCT", 300_000_00)),
    bl(MAIN, "2026-11-04", 1_000_00, m("payroll", new Types.ObjectId(), "PAY-OCT", 1_000_00)),               // a payroll payment reversed
    bl(MAIN, "2026-11-05", -1_000_00, m("expense", eCom, "EXP-COM", 1_000_00)),
    bl(MAIN, "2026-11-10", -5_250_00, m("bill", new Types.ObjectId(), "BILL-1", 5_250_00)),
    bl(PSP, "2026-11-12", -9_500_00, { transfer: { id: T2, otherAccountId: MAIN, otherAccountName: "Main", otherTransactionId: new Types.ObjectId(), otherAmountMinor: 9_500_00, otherCurrency: "AED" }, settlement: { id: new Types.ObjectId(), number: "PSP-1" } }),
    bl(MAIN, "2026-11-12", 9_500_00, { transfer: { id: T2, otherAccountId: PSP, otherAccountName: "Gateway", otherTransactionId: new Types.ObjectId(), otherAmountMinor: 9_500_00, otherCurrency: "AED" }, settlement: { id: new Types.ObjectId(), number: "PSP-1" } }),
    bl(PSP, "2026-11-12", -500_00, { ...m("expense", eFee, "EXP-FEE", 500_00), settlement: { id: new Types.ObjectId(), number: "PSP-1" } }),
    bl(MAIN, "2026-11-15", -5_000_00, m("expense", eComp, "EXP-PC", 5_000_00)),
    bl(MAIN, "2026-11-16", 100_000_00, { status: "unmatched", category: "loan_financing", subcategory: "loan_principal" }), // loan received (categorised line)
    bl(MAIN, "2026-11-20", -2_660_00, { status: "unmatched", category: "loan_financing", subcategory: "loan_principal" }), // loan repaid
    bl(MAIN, "2026-11-18", -200_00, { status: "unmatched" }),
    bl(MAIN, "2026-11-19", -100_00, { status: "duplicate" }),
    bl(PSP, "2026-11-25", 3_000_00, m("invoice", new Types.ObjectId(), "INV-PSP2", 3_000_00)),              // waiting to settle
    bl(INR, "2026-11-20", 50_000_00, m("invoice", new Types.ObjectId(), "INV-INR", 50_000_00)),
    bl(INR, "2026-11-21", -30_000_00, m("payroll", new Types.ObjectId(), "PAY-OCT", 30_000_00)),
    bl(INR, "2026-12-10", -1_000_00, { status: "unmatched" }),                                                // dated after the period
  ]);
  // Stored balances = opening + every line (as finance keeps them).
  for (const id of [MAIN, SAV, PETTY, PSP, INR]) {
    const a: any = await BankAccount.collection.findOne({ _id: id });
    const sum = (await BankTransaction.collection.find({ accountId: id }).toArray()).reduce((n: number, l: any) => n + l.amountMinor, 0);
    await BankAccount.collection.updateOne({ _id: id }, { $set: { currentBalanceMinor: a.openingBalanceMinor + sum } });
  }

  // Receivables
  const inv = async (n: string, total: number, issue: string, due: string | null, pays: [number, string][], extra: Record<string, unknown> = {}) => {
    const paid = pays.reduce((x, [a]) => x + a, 0);
    return (await Invoice.collection.insertOne({ organizationId: O, invoiceNumber: n, customerId, customerName: `Client ${n}`, salespersonName: "Sales", status: paid >= total ? "paid" : paid ? "partial" : "sent", currency: "AED", issueDate: d(issue), ...(due ? { dueDate: d(due) } : {}), lineItems: [], subtotalMinor: total, taxTotalMinor: 0, totalMinor: total, amountPaidMinor: paid, balanceMinor: total - paid, payments: pays.map(([a, on]) => ({ _id: new Types.ObjectId(), method: "cash", amountMinor: a, paidOn: d(on) })), exchangeRate: 1, baseTotalMinor: total, createdAt: now, updatedAt: now, ...extra })).insertedId;
  };
  await inv("I-OLD", 42_000_00, "2026-09-01", "2026-09-30", [[42_000_00, "2026-10-05"]]);
  await inv("I-OCT", 105_000_00, "2026-10-10", "2026-10-20", [[52_500_00, "2026-10-15"], [52_500_00, "2026-11-15"]]);
  const iCn = await inv("I-CN", 10_500_00, "2026-10-01", "2026-10-31", []);
  await inv("PF", 42_000_00, "2026-10-12", "2026-11-11", [[21_000_00, "2026-10-20"]], { proforma: { at: d("2026-10-12") } });
  await inv("ENR", 20_000_00, "2026-11-01", "2026-12-01", [[5_000_00, "2026-11-01"]], { external: { source: "crm" } });
  await inv("OB", 3_000_00, "2024-01-01", "2024-01-31", [], { external: { source: "old_books" } });
  await inv("I-NODUE", 1_000_00, "2026-11-05", null, []);
  await inv("I-VOID", 9_999_00, "2026-10-05", "2026-10-30", [], { status: "void" });
  await inv("I-INR", 200_000_00, "2026-10-18", "2026-11-17", [], { currency: "INR" });
  await CreditNote.collection.insertOne({ organizationId: O, creditNoteNumber: "CN-1", invoiceId: iCn, invoiceNumber: "I-CN", customerId, customerName: "Client", reason: "Discount", status: "applied", lineItems: [], subtotalMinor: 1_050_00, taxTotalMinor: 0, totalMinor: 1_050_00, amountAppliedMinor: 1_050_00, applications: [{ invoiceId: iCn, amountMinor: 1_050_00, appliedAt: d("2026-11-05") }], currency: "AED", issuedAt: d("2026-10-01"), createdAt: now, updatedAt: now });

  // Obligations
  await Bill.collection.insertMany([
    { organizationId: O, billNumber: "BILL-1", vendorId, vendorName: "Supplier", billDate: d("2026-10-08"), dueDate: d("2026-11-08"), status: "partially_paid", currency: "AED", lineItems: [], subtotalMinor: 10_000_00, taxTotalMinor: 500_00, totalMinor: 10_500_00, amountPaidMinor: 5_250_00, balanceMinor: 5_250_00, payments: [{ _id: new Types.ObjectId(), amountMinor: 5_250_00, paidOn: d("2026-11-10") }], createdAt: now, updatedAt: now },
    { organizationId: O, billNumber: "BILL-2", vendorId, vendorName: "Supplier", billDate: d("2026-10-09"), dueDate: d("2026-12-09"), status: "partially_paid", currency: "AED", lineItems: [], subtotalMinor: 2_000_00, taxTotalMinor: 100_00, totalMinor: 2_100_00, amountPaidMinor: 1_050_00, balanceMinor: 1_050_00, payments: [], createdAt: now, updatedAt: now }, // half settled by a vendor credit
  ]);
  const lA = new Types.ObjectId(), lB = new Types.ObjectId(), P1 = new Types.ObjectId();
  const pline = (_id: unknown, name: string, emp: string, payable: number, deductions: { label: string; amountMinor: number }[] = []) => ({ _id, hrmsPayslipId: `PS-${name}`, hrmsEmployeeId: emp, employeeCode: name, name, earnings: [], deductions, grossMinor: payable, deductionsMinor: 0, netFromHrmsMinor: payable, adjustmentsMinor: 0, payableMinor: payable, amountPaidMinor: 0, payable: true, status: "pending" });
  const run = (await PayrollRun.collection.insertOne({ organizationId: O, source: "hrms", hrmsOrgId: "H", runNumber: "PAY-OCT", period: "2026-10", currency: "AED", status: "partially_paid",
    lines: [pline(lA, "A", "E-A", 300_000_00, [{ label: "Salary advance", amountMinor: 2_000_00 }, { label: "Loan repayment (Visa loan)", amountMinor: 400_00 }]), pline(lB, "B", "E-B", 100_000_00, [{ label: "Salary advance", amountMinor: 700_00 }])],
    adjustments: [{ _id: new Types.ObjectId(), externalId: "x", hrmsEmployeeId: "E-A", lineId: lA, kind: "addition", source: "crm_commission", label: "c", amountMinor: 0, crmPayoutIds: [P1], commissionRecordIds: [], csPayoutIds: [] }],
    payments: [
      { _id: new Types.ObjectId(), paymentId: "p1", method: "bank_transfer", paidOn: d("2026-11-03"), amountMinor: 300_000_00, currency: "AED", allocations: [{ lineId: lA, amountMinor: 300_000_00 }] },
      { _id: new Types.ObjectId(), paymentId: "p2", method: "bank_transfer", paidOn: d("2026-11-03"), amountMinor: 1_000_00, currency: "AED", allocations: [{ lineId: lB, amountMinor: 1_000_00 }], reversedAt: d("2026-11-04") },
    ], createdAt: now, updatedAt: now })).insertedId;
  void run;
  const payout = (_id: any, amount: number, state: string, extra: Record<string, unknown> = {}) => ({ _id, key: `k-${String(_id)}`, organizationId: O, crm: "sales", crmName: "Sales", month: "2026-10", userId: "u", personName: "Rep", currency: "AED", amountMinor: amount, state, approvedById: U, approvedAt: d("2026-11-01"), createdAt: now, updatedAt: now, ...extra });
  await CrmCommissionPayout.collection.insertMany([payout(P1, 20_000_00, "approved", { payrollRunId: new Types.ObjectId() }), payout(new Types.ObjectId(), 4_000_00, "approved"), payout(new Types.ObjectId(), 1_000_00, "paid", { paidOn: d("2026-11-05"), expenseId: eCom })]);
  await CommissionRecord.collection.insertOne({ organizationId: O, structureId: new Types.ObjectId(), salespersonId: U, salespersonName: "Rep", invoiceId: new Types.ObjectId(), invoiceNumber: "I-OCT", invoiceTotalMinor: 1, commissionMinor: 500_00, basis: "payment_received", status: "earned", calculatedAt: d("2026-10-20"), paidExpenseId: "", payrollRunId: null, createdAt: now, updatedAt: now });
  const loan = (await Loan.collection.insertOne({ organizationId: O, loanNumber: "LN-1", type: "taken", counterpartyName: "Lender", counterpartyType: "other", principalMinor: 100_000_00, interestRate: 5, interestType: "simple", startDate: "2026-11-16", dueDate: "2027-11-16", repaymentFrequency: "monthly", status: "active", createdById: U, createdAt: now, updatedAt: now })).insertedId;
  await LoanRepayment.collection.insertOne({ organizationId: O, loanId: loan, paidOn: "2026-11-20", principalMinor: 2_660_00, interestMinor: 0, createdById: U, createdAt: now, updatedAt: now });

  // ── Cash flow ──────────────────────────────────────────────────────────────
  step("Cash flow, October–November");
  const cf = await fp.financialReport(org, "cashflow", ...PERIOD);
  const a = side(cf as any);
  check("opening 15,000 (10,000 opening + September's 5,000)", tot(a, "opening") === 15_000_00, j(a.totals));
  check("petty cash opened in the period: its 500 opening said apart", tot(a, "opened") === 500_00);
  check("money in 156,000: collections 42,000 + 10,000 + 3,000 (PSP once), payroll reversal 1,000, loan received 100,000 — transfers out", tot(a, "inflows") === 156_000_00, j(tot(a, "inflows")));
  check("money out 334,710 (transfers and the PSP settlement transfer out)", tot(a, "outflows") === 334_710_00, j(tot(a, "outflows")));
  check("net movement −178,710", tot(a, "net") === -178_710_00);
  check("transfers net 0 in AED", tot(a, "transfers") === 0);
  check("closing −163,210 = opening + opened + net + transfers; check line 0", tot(a, "closing") === -163_210_00 && tot(a, "check") === 0, j([tot(a, "closing"), tot(a, "check")]));
  check("operating: collections 55,000, salaries −299,000 (reversal netted), commission −1,000, suppliers −5,250, rent −20,000, fees −500",
    line(a, "operating:collections") === 55_000_00 && line(a, "operating:salaries") === -299_000_00 && line(a, "operating:commission") === -1_000_00 && line(a, "operating:suppliers") === -5_250_00 && line(a, "operating:rent") === -20_000_00 && line(a, "operating:operating_expenses") === -500_00, j(a.sections.find((s) => s.key === "operating")));
  check("investing: computers −5,000", line(a, "investing:asset_purchases") === -5_000_00);
  check("financing: loan received 100,000, repaid −2,660", line(a, "financing:loan_receipts") === 100_000_00 && line(a, "financing:loan_repayments") === -2_660_00);
  check("not identified −200 and marked duplicate −100 shown apart", line(a, "unidentified:out") === -200_00 && line(a, "flagged:duplicate") === -100_00);
  const months = cf.months.map((mm) => side({ sides: mm.sides as any }));
  check("months chain: October's closing = November's opening", tot(months[0], "closing") === tot(months[1], "opening"), j(months.map((x) => [tot(x, "opening"), tot(x, "closing")])));
  check("months add up: October net + November net = the period's", (tot(months[0], "net") ?? 0) + (tot(months[1], "net") ?? 0) === tot(a, "net"));
  const inr = side(cf as any, "INR");
  check("INR apart: in 50,000, out 30,000, closing 20,000 (the December line not in the period)", tot(inr, "inflows") === 50_000_00 && tot(inr, "outflows") === 30_000_00 && tot(inr, "closing") === 20_000_00, j(inr?.totals));
  check("the future-dated line is warned about", cf.warnings.some((w) => /future/.test(w)), j(cf.warnings));
  for (const k of ["operating", "investing", "financing", "unidentified", "flagged", "transfers"]) {
    check(`records add up: AED ${k} records = ${k} total`, fp.linesOf(cf.rows, k).filter((x) => x.currency === "AED").reduce((n, x) => n + x.amountMinor, 0) === sec(a, k));
  }

  // ── Cash position ──────────────────────────────────────────────────────────
  step("Cash and bank position");
  const cash = await fp.financialReport(org, "cash", ...PERIOD);
  const c = side(cash as any);
  check("available = Main −196,710 + Savings 30,000 + Petty 500 = −166,210", tot(c, "available") === -166_210_00, j(c.totals));
  check("PSP pending 3,000 (settled money not counted twice), kept out of available", tot(c, "psp") === 3_000_00);
  check("the negative account is flagged", tot(c, "negative") === -196_710_00 && cash.warnings.some((w) => /below zero/.test(w)));
  check("nothing confirmed by a reconciled statement", tot(c, "confirmed") === 0 && cash.warnings.some((w) => /never been reconciled/.test(w)));
  const oct = side({ sides: cash.months[0]!.sides as any });
  check("as of 31 October: Main 7,000 + Savings 30,000 + Petty 500 = 37,500; PSP 10,000", tot(oct, "available") === 37_500_00 && tot(oct, "psp") === 10_000_00, j(oct.totals));
  check("cash closing = cash flow closing (one source)", tot(c, "recorded") === tot(a, "closing"));

  // ── Receivables ────────────────────────────────────────────────────────────
  step("Receivables");
  const rec = await fp.financialReport(org, "receivables", ...PERIOD);
  const r = side(rec as any);
  check("invoices (enforceable) 10,450: I-CN 10,500 − 1,050 credit applied 5 Nov, + I-NODUE 1,000", line(r, "kind:invoice") === 10_450_00, j(r.sections));
  check("enrolment balance 15,000; pro-forma 21,000 conditional; old books 3,000 apart", line(r, "kind:enrolment") === 15_000_00 && line(r, "kind:proforma") === 21_000_00 && line(r, "kind:old_books") === 3_000_00);
  check("enforceable 25,450", tot(r, "enforceable") === 25_450_00);
  check("void invoice left out; paid invoices gone", !rec.rows.some((x) => x.number === "I-VOID" || x.number === "I-OCT" || x.number === "I-OLD"));
  check("ageing: old books > 365 days, no due date flagged", line(r, "age:d365_plus") === 3_000_00 && line(r, "age:no_due") === 1_000_00 && rec.warnings.some((w) => /no valid due date/.test(w)));
  const rOct = side({ sides: rec.months[0]!.sides as any });
  check("as of 31 October: I-OCT's second half (52,500) still owed, the credit not yet applied (I-CN 10,500)", rec.months[0]!.month === "2026-10" && line(rOct, "kind:invoice") === 63_000_00, j(rOct.sections));
  const rSep = side((await fp.financialReport(org, "receivables", "2026-09-30", "2026-09-30")) as any);
  check("as of 30 September: I-OLD 42,000 owed, not yet due (paid 5 October)", line(rSep, "kind:invoice") === 42_000_00 && line(rSep, "age:not_due") === 42_000_00, j(rSep.sections));
  check("INR receivable apart: 200,000", line(side(rec as any, "INR"), "kind:invoice") === 200_000_00);

  // ── Obligations ────────────────────────────────────────────────────────────
  step("Obligations");
  const obl = await fp.financialReport(org, "obligations", ...PERIOD);
  const o = side(obl as any);
  check("bills: 5,250 left on BILL-1 + 1,050 on BILL-2 (its vendor credit taken off) = 6,300", line(o, "obl:bills") === 6_300_00, j(o.sections));
  check("salaries: B's 100,000 (A paid; the reversed payment not counted)", line(o, "obl:salaries") === 100_000_00);
  check("commission: 4,000 approved + 500 earned (the one on the run and the one paid not counted)", line(o, "obl:commission") === 4_500_00);
  check("expenses: 3,000 not paid (the one paid 1 November not counted)", line(o, "obl:expenses") === 3_000_00);
  check("loan: 100,000 − 2,660 repaid = 97,340", line(o, "obl:loans") === 97_340_00);
  check("total 211,140", tot(o, "total") === 211_140_00, j(o.totals));
  check("reimbursements: HRMS not reachable here, said so", obl.warnings.some((w) => /Reimbursements/.test(w)), j(obl.warnings));
  check("VAT indicative, not added in", (o.sections.find((s) => s.key === "info")?.lines.length ?? 0) === 1 && tot(o, "total") === sec(o, "obl"));
  const oOct = side({ sides: obl.months[0]!.sides as any });
  check("as of 31 October: salaries 400,000 unpaid, commission 5,500, bills 11,550, expenses 5,000, no loan yet", line(oOct, "obl:salaries") === 400_000_00 && line(oOct, "obl:commission") === 5_500_00 && line(oOct, "obl:bills") === 11_550_00 && line(oOct, "obl:expenses") === 5_000_00 && line(oOct, "obl:loans") === 0, j(oOct.sections));

  // ── Advances ───────────────────────────────────────────────────────────────
  step("Employee advances");
  const adv = await fp.financialReport(org, "advances", ...PERIOD);
  const v = side(adv as any);
  check("issued through HRMS 5,000; recovered 2,700; outstanding 3,000 for A (employee named from finance's text)", tot(v, "issued_hrms") === 5_000_00 && tot(v, "recovered") === 2_700_00 && tot(v, "outstanding") === 3_000_00 && sec(v, "outstanding") === 3_000_00, j(v.totals));
  check("B repaid 700 with no advance in finance: its own section (an older advance), not netted into outstanding", tot(v, "earlier") === 700_00 && sec(v, "earlier") === -700_00, j(v.sections));
  check("old-books advance 7,000: outstanding not calculable, said so", tot(v, "unknown") === 7_000_00);
  check("visa-loan deduction 400 shown apart as another loan", line(v, "other_loans:other") === 400_00);
  check("advances kept apart from operating expenses (their own report)", adv.rows.every((x) => x.section !== "operating"));

  // ── Position ───────────────────────────────────────────────────────────────
  step("Management financial position");
  const pos = await fp.financialReport(org, "position", ...PERIOD);
  const p = side(pos as any);
  check("has: cash −166,210, PSP 3,000, receivables 25,450 (enforceable), advances 3,000", line(p, "have:cash") === -166_210_00 && line(p, "have:psp") === 3_000_00 && line(p, "have:receivables") === 25_450_00 && line(p, "have:advances") === 3_000_00, j(p.sections));
  check("owes 211,140", sec(p, "owe") === 211_140_00);
  check("net −345,900; with pro-forma −324,900; old books not in", tot(p, "net") === -345_900_00 && tot(p, "net_with_proforma") === -324_900_00, j(p.totals));
  check("available cash less obligations: −166,210 − 211,140 = −377,350 (no receivables)", tot(p, "available_less") === -377_350_00);

  step("Root's feed");
  const root = await portal.financialForPortal({ org, from: PERIOD[0], to: PERIOD[1], report: "position" }) as any;
  check("Root gets the same figures, without the records", typeof root === "object" && !("rows" in root) && root.sides[0].totals.find((t: any) => t.key === "net").amountMinor === -345_900_00);
  const rl = await portal.financialLinesForPortal({ org, from: PERIOD[0], to: PERIOD[1], report: "receivables", line: "all" }) as any;
  check("Root's receivable records: each once (by kind), AED total 49,450; INR apart", rl.totals.amountMinor === 49_450_00 && (rl.otherCurrencies ?? []).some((x: any) => x.currency === "INR"), j(rl.totals));
  check("a wrong report is refused", typeof (await portal.financialForPortal({ org, from: PERIOD[0], to: PERIOD[1], report: "nope" })) === "string");

  step("Nothing written");
  const main: any = await BankAccount.collection.findOne({ _id: MAIN });
  check("bank balance, lines and records unchanged by the reports", main.currentBalanceMinor === -196_710_00 && (await BankTransaction.collection.countDocuments({ organizationId: O })) === 22);
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? `, ${failures} failed` : ""}`);
process.exit(failures ? 1 : 0);
