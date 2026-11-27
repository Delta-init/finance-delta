/**
 * Phase 3 management profitability (2026-11-27), against a scratch database through the real services:
 * salary incurred in October and paid in November, part paid, unpaid and on hold; advance recovery shown, not added;
 * approved unpaid commission; commission inside payroll; commission paid directly (never twice); supplier bills paid
 * later; part collections; collections for an earlier month's invoice; VAT out of management income; credit notes and
 * vendor credits; bill mirrors and payroll payment expenses never counted beside what they mirror; AED and INR apart;
 * cash movement without transfers; every total equal to its records; the invoice view's income equal to the P&L's.
 *
 * Run through scripts/phase-3-management-profit-e2e.sh. Scratch database only.
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
const { VendorCredit } = await import("../modules/vendor-credit/vendor-credit.model");
const { Bill } = await import("../modules/bill/bill.model");
const { Expense } = await import("../modules/expense/expense.model");
const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
const { CrmCommissionPayout } = await import("../modules/crm-commission/crm-commission-payout.model");
const { CommissionRecord } = await import("../modules/commission/commission-record.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { syncBillExpense } = await import("../modules/bill/bill-expense");
const reports = await import("../modules/reports/reports.service");
const mp = await import("../modules/reports/management-profit.service");
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

await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const now = new Date();
const d = (s: string) => new Date(`${s}T10:00:00Z`);
const O = (await Organization.collection.insertOne({ name: "Test Org", slug: `t-${Date.now()}`, baseCurrency: "AED", currency: "AED", createdAt: now, updatedAt: now })).insertedId;
const org = String(O);
const customerId = new Types.ObjectId(), vendorId = new Types.ObjectId(), U = new Types.ObjectId();
const OCT = ["2026-10-01", "2026-10-31"] as const, NOV = ["2026-11-01", "2026-11-30"] as const;

const invoice = async (n: string, subtotal: number, tax: number, issue: string, payments: { amount: number; on: string; ti?: number; original?: { currency: string; amountMinor: number } }[], opts: { currency?: string; proforma?: boolean } = {}) => {
  const total = subtotal + tax;
  const pays = payments.map((p, i) => ({ _id: new Types.ObjectId(), method: "bank_transfer", amountMinor: p.amount, paidOn: d(p.on), reference: `R${n}${i}`,
    ...(p.ti !== undefined ? { taxInvoice: { number: `TI-${n}-${i}`, taxMinor: p.ti } } : {}), ...(p.original ? { original: p.original } : {}) }));
  const paid = payments.reduce((x, p) => x + p.amount, 0);
  const r = await Invoice.collection.insertOne({
    organizationId: O, invoiceNumber: n, customerId, customerName: "Client", salespersonName: "Sales", status: paid >= total ? "paid" : paid ? "partial" : "sent",
    currency: opts.currency ?? "AED", issueDate: d(issue), dueDate: d("2026-12-31"), lineItems: [], subtotalMinor: subtotal, taxTotalMinor: tax, totalMinor: total,
    amountPaidMinor: paid, balanceMinor: total - paid, payments: pays, exchangeRate: 1, baseTotalMinor: total, ...(opts.proforma ? { proforma: { at: d(issue) } } : {}), createdAt: now, updatedAt: now,
  });
  return { id: r.insertedId, n };
};

try {
  step("Setting up October and November");
  // Income
  const i0 = await invoice("INV-SEP", 40_000_00, 2_000_00, "2026-09-20", [{ amount: 42_000_00, on: "2026-10-05" }]);            // earlier invoice, collected in Oct
  const i1 = await invoice("INV-OCT", 100_000_00, 5_000_00, "2026-10-10", [{ amount: 52_500_00, on: "2026-10-15" }, { amount: 52_500_00, on: "2026-11-15" }]); // part collected each month
  await invoice("PF-OCT", 40_000_00, 2_000_00, "2026-10-12", [{ amount: 21_000_00, on: "2026-10-20", ti: 1_000_00 }], { proforma: true }); // pro-forma, tax invoice per payment
  await invoice("INV-RUPEE-PAID", 10_000_00, 500_00, "2026-10-14", [{ amount: 10_500_00, on: "2026-10-16", original: { currency: "INR", amountMinor: 250_000_00 } }]); // AED invoice paid in rupees
  await invoice("INV-INR", 200_000_00, 0, "2026-10-18", [], { currency: "INR" });                                                   // a rupee invoice
  await CreditNote.collection.insertOne({ organizationId: O, creditNoteNumber: "CN-1", invoiceId: i1.id, invoiceNumber: i1.n, customerId, customerName: "Client", reason: "Discount", status: "issued", lineItems: [], subtotalMinor: 5_000_00, taxTotalMinor: 250_00, totalMinor: 5_250_00, amountAppliedMinor: 0, currency: "AED", issuedAt: d("2026-10-25"), createdAt: now, updatedAt: now });
  void i0;

  // Payroll: October run, paid in November (part) — and a returned and an imported run that must not count.
  const lA = new Types.ObjectId(), lB = new Types.ObjectId(), lC = new Types.ObjectId(), lD = new Types.ObjectId();
  const P1 = new Types.ObjectId(), P2 = new Types.ObjectId(), P3 = new Types.ObjectId();
  const line = (_id: unknown, name: string, gross: number, deductions: { label: string; amountMinor: number }[], adjustments: number, payable: number, paid: number, extra: Record<string, unknown> = {}) => ({
    _id, hrmsPayslipId: `PS-${name}`, hrmsEmployeeId: `E-${name}`, employeeCode: name, name, earnings: [{ label: "Basic", amountMinor: gross }], deductions,
    grossMinor: gross, deductionsMinor: deductions.reduce((n, x) => n + x.amountMinor, 0), netFromHrmsMinor: gross - deductions.reduce((n, x) => n + x.amountMinor, 0),
    adjustmentsMinor: adjustments, payableMinor: payable, amountPaidMinor: paid, payable: true, status: paid >= payable ? "paid" : paid ? "partially_paid" : "pending", ...extra,
  });
  const runOct = (await PayrollRun.collection.insertOne({
    organizationId: O, source: "hrms", hrmsOrgId: "H", runNumber: "PAY-OCT", period: "2026-10", currency: "AED", status: "partially_paid",
    lines: [
      line(lA, "A", 285_000_00, [{ label: "Salary advance", amountMinor: 5_000_00 }], 20_000_00, 300_000_00, 300_000_00), // 285k − 5k recovery + 20k commission = 300k, paid
      line(lB, "B", 100_000_00, [], 0, 100_000_00, 0),                                                                       // unpaid
      line(lC, "C", 50_000_00, [], 0, 50_000_00, 50_000_00, { currency: "INR" }),                                           // rupee line, paid
      line(lD, "D", 10_000_00, [], 0, 10_000_00, 0, { status: "on_hold" }),                                                 // on hold
    ],
    adjustments: [{ _id: new Types.ObjectId(), externalId: "x1", hrmsEmployeeId: "E-A", lineId: lA, kind: "addition", source: "crm_commission", label: "CRM commission", amountMinor: 20_000_00, crmPayoutIds: [P1], commissionRecordIds: [], csPayoutIds: [] }],
    payments: [{ _id: new Types.ObjectId(), paymentId: "p1", method: "bank_transfer", paidOn: d("2026-11-03"), amountMinor: 300_000_00, currency: "AED", allocations: [{ lineId: lA, amountMinor: 300_000_00 }] }],
    payableMinor: 460_000_00, amountPaidMinor: 350_000_00, balanceMinor: 110_000_00, createdAt: now, updatedAt: now,
  })).insertedId;
  await PayrollRun.collection.insertOne({ organizationId: O, source: "hrms", hrmsOrgId: "H2", runNumber: "PAY-RET", period: "2026-10", currency: "AED", status: "returned", lines: [line(new Types.ObjectId(), "R", 99_000_00, [], 0, 99_000_00, 0)], adjustments: [], payments: [], createdAt: now, updatedAt: now });
  await PayrollRun.collection.insertOne({ organizationId: O, source: "hrms", hrmsOrgId: "H3", runNumber: "PAY-IMP", period: "2026-11", currency: "AED", status: "imported", lines: [line(new Types.ObjectId(), "I", 77_000_00, [], 0, 77_000_00, 0)], adjustments: [], payments: [], createdAt: now, updatedAt: now });
  // The payment's own expense (as posting.service writes it) — never counted beside the payable.
  await Expense.collection.insertOne({ organizationId: O, expenseNumber: "EXP-PAY", category: "payroll_benefits", subcategory: "basic_salary", description: "Payroll PAY-OCT", expenseDate: d("2026-11-03"), paidOn: d("2026-11-03"), amountMinor: 300_000_00, taxMinor: 0, totalMinor: 300_000_00, currency: "AED", status: "approved", source: { kind: "payroll", key: `payroll:${runOct}:p1` }, createdAt: now, updatedAt: now });

  // Commission: P1 on the run (in payroll), P2 approved not paid, P3 paid directly (its expense not counted again); a finance record earned.
  const payout = (_id: any, amount: number, state: string, extra: Record<string, unknown> = {}) => ({ _id, key: `k-${_id}`, organizationId: O, crm: "sales", crmName: "Sales CRM", month: "2026-10", userId: "u", personName: "Rep", currency: "AED", amountMinor: amount, state, approvedById: U, approvedAt: d("2026-11-01"), createdAt: now, updatedAt: now, ...extra });
  const expCom = (await Expense.collection.insertOne({ organizationId: O, expenseNumber: "EXP-COM", category: "sales_commission", subcategory: "sales_commission", description: "Commission paid", expenseDate: d("2026-11-05"), paidOn: d("2026-11-05"), amountMinor: 1_000_00, taxMinor: 0, totalMinor: 1_000_00, currency: "AED", status: "approved", createdAt: now, updatedAt: now })).insertedId;
  await CrmCommissionPayout.collection.insertMany([
    payout(P1, 20_000_00, "approved", { payrollRunId: runOct }),
    payout(P2, 4_000_00, "approved"),
    payout(P3, 1_000_00, "paid", { expenseId: expCom, paidOn: d("2026-11-05") }),
  ]);
  await CommissionRecord.collection.insertOne({ organizationId: O, structureId: new Types.ObjectId(), salespersonId: U, salespersonName: "Rep", invoiceId: i1.id, invoiceNumber: i1.n, invoiceTotalMinor: 105_000_00, commissionMinor: 500_00, basis: "payment_received", status: "earned", calculatedAt: d("2026-10-20"), paidExpenseId: "", payrollRunId: null, createdAt: now, updatedAt: now });

  // Supplier: a bill in October paid half in November (its mirror must not count); a vendor credit.
  const bill = (await Bill.collection.insertOne({ organizationId: O, billNumber: "BILL-1", vendorId, vendorName: "Supplier", billDate: d("2026-10-08"), dueDate: d("2026-11-08"), status: "partially_paid", currency: "AED",
    lineItems: [{ description: "Goods", quantity: 1, unitPriceMinor: 10_000_00, discountPct: 0, taxPct: 5, lineTotalMinor: 10_500_00 }], subtotalMinor: 10_000_00, taxTotalMinor: 500_00, totalMinor: 10_500_00,
    amountPaidMinor: 5_250_00, balanceMinor: 5_250_00, payments: [{ _id: new Types.ObjectId(), amountMinor: 5_250_00, paidOn: d("2026-11-10"), method: "bank_transfer" }], createdAt: now, updatedAt: now })).insertedId;
  await syncBillExpense(org, bill);
  await VendorCredit.collection.insertOne({ organizationId: O, creditNumber: "VC-1", vendorId, vendorName: "Supplier", sourceBillNumber: "BILL-1", reason: "Returned", issueDate: d("2026-10-28"), status: "issued", currency: "AED", lineItems: [], subtotalMinor: 1_000_00, taxTotalMinor: 50_00, totalMinor: 1_050_00, amountAppliedMinor: 0, createdAt: now, updatedAt: now });

  // Other operating: rent paid, a service unpaid, an advance (not a P&L category) and a rupee expense.
  await Expense.collection.insertMany([
    { organizationId: O, expenseNumber: "EXP-RENT", category: "rent_utilities", subcategory: "office_rent", description: "Rent", expenseDate: d("2026-10-01"), paidOn: d("2026-10-01"), amountMinor: 20_000_00, taxMinor: 0, totalMinor: 20_000_00, currency: "AED", status: "approved", createdAt: now, updatedAt: now },
    { organizationId: O, expenseNumber: "EXP-OWED", category: "software_it", subcategory: null, description: "Software", expenseDate: d("2026-10-22"), paidOn: null, amountMinor: 3_000_00, taxMinor: 0, totalMinor: 3_000_00, currency: "AED", status: "approved", createdAt: now, updatedAt: now },
    { organizationId: O, expenseNumber: "EXP-ADV", category: "employee_advances", subcategory: "salary_advances", description: "Advance", expenseDate: d("2026-10-02"), paidOn: d("2026-10-02"), amountMinor: 8_000_00, taxMinor: 0, totalMinor: 8_000_00, currency: "AED", status: "approved", source: { kind: "hrms_advance" }, createdAt: now, updatedAt: now },
    { organizationId: O, expenseNumber: "EXP-BONUS", category: "payroll_benefits", subcategory: "bonuses", description: "One-time bonus", expenseDate: d("2026-10-30"), paidOn: null, amountMinor: 2_000_00, taxMinor: 0, totalMinor: 2_000_00, currency: "AED", status: "approved", source: { kind: "hrms_one_time" }, createdAt: now, updatedAt: now },
    { organizationId: O, expenseNumber: "EXP-INR", category: "rent_utilities", subcategory: "office_rent", description: "Bangalore rent", expenseDate: d("2026-10-03"), paidOn: d("2026-10-03"), amountMinor: 30_000_00, taxMinor: 0, totalMinor: 30_000_00, currency: "INR", status: "approved", createdAt: now, updatedAt: now },
  ]);

  // Bank lines: money in, payroll out, a transfer pair (left out), an unmatched charge, a commission payment.
  const A1 = new Types.ObjectId(), A2 = new Types.ObjectId(), T = new Types.ObjectId();
  const bl = (acct: unknown, on: string, amount: number, extra: Record<string, unknown> = {}) => ({ organizationId: O, accountId: acct, accountName: acct === A1 ? "Main" : "Savings", currency: "AED", date: d(on), description: "line", amountMinor: amount, type: amount > 0 ? "credit" : "debit", runningBalanceMinor: 0, source: "manual", status: "matched", matches: [], createdAt: now, updatedAt: now, ...extra });
  await BankTransaction.collection.insertMany([
    bl(A1, "2026-11-15", 52_500_00, { matches: [{ type: "invoice", referenceId: String(i1.id), referenceNumber: i1.n, amountMinor: 52_500_00 }] }),
    bl(A1, "2026-11-03", -300_000_00, { matches: [{ type: "payroll", referenceId: String(runOct), referenceNumber: "PAY-OCT", amountMinor: 300_000_00 }] }),
    bl(A1, "2026-11-10", -5_250_00, { matches: [{ type: "bill", referenceId: String(bill), referenceNumber: "BILL-1", amountMinor: 5_250_00 }] }),
    bl(A1, "2026-11-05", -1_000_00, { matches: [{ type: "expense", referenceId: String(expCom), referenceNumber: "EXP-COM", amountMinor: 1_000_00 }] }),
    bl(A1, "2026-11-20", -200_00, { status: "unmatched" }),
    bl(A1, "2026-11-04", 1_000_00, { matches: [{ type: "payroll", referenceId: String(runOct), referenceNumber: "PAY-OCT", amountMinor: 1_000_00 }] }), // a payroll payment reversed, back in
    bl(A1, "2026-11-21", -100_00, { status: "duplicate" }),
    bl(A1, "2026-11-12", -50_000_00, { transfer: { id: T, direction: "out" } }),
    bl(A2, "2026-11-12", 50_000_00, { transfer: { id: T, direction: "in" } }),
  ]);

  // ── Invoice view ───────────────────────────────────────────────────────────
  step("Invoice-based view, October");
  const inv = await mp.getManagementProfit(org, ...OCT, "invoice");
  const aed = inv.sides.find((s) => s.currency === "AED")!;
  const plOct = await reports.profitLossPeriod(org, ...OCT, "invoiced");
  check("income = the P&L's invoiced income (before VAT, less the credit note, the rupee part out)", aed.income.total === plOct.income.total, j([aed.income.total, plOct.income.total]));
  check("income 1,00,000 + 40,000 pro-forma + 0 (paid all in rupees) − 5,000 credit = 135,000", aed.income.total === 135_000_00, j(aed.income));
  check("payroll in October: 300,000 + 100,000 + 10,000 on hold + 2,000 typed bonus = 412,000 (rupee line apart; returned/imported runs out; payment expense not on top)", aed.payroll.total === 412_000_00, j(aed.payroll));
  check("payroll paid 300,000, unpaid 112,000 (the bonus not paid yet)", aed.payroll.paid === 300_000_00 && aed.payroll.unpaid === 112_000_00, j(aed.payroll));
  const pd = inv.payroll.find((p) => p.currency === "AED")!;
  check("payroll detail: gross 395,000, deductions 5,000 of which recoveries 5,000, additions 20,000 of which commission 20,000, payable 410,000, outstanding 110,000, 1 on hold (10,000)",
    pd.grossMinor === 395_000_00 && pd.deductionsMinor === 5_000_00 && pd.recoveriesMinor === 5_000_00 && pd.additionsMinor === 20_000_00 && pd.commissionMinor === 20_000_00 && pd.payableMinor === 410_000_00 && pd.outstandingMinor === 110_000_00 && pd.onHold === 1 && pd.onHoldMinor === 10_000_00, j(pd));
  check("advance recovery shown, not added: payroll cost is the payable (+ the typed bonus), not payable + recovery", aed.payroll.total === pd.payableMinor + 2_000_00);
  check("commission outside payroll: 4,000 approved + 1,000 paid directly + 500 earned = 5,500 (the payout on the run not again; its direct-payment expense not again)", aed.commission.total === 5_500_00, j(aed.commission));
  check("commission paid 1,000, unpaid 4,500", aed.commission.paid === 1_000_00 && aed.commission.unpaid === 4_500_00, j(aed.commission));
  const cd = inv.commission.find((c) => c.currency === "AED")!;
  check("commission detail: approved unpaid 4,000, paid 1,000, earned 500, in payroll 20,000", cd.approvedUnpaidMinor === 4_000_00 && cd.paidMinor === 1_000_00 && cd.earnedMinor === 500_00 && cd.inPayrollMinor === 20_000_00, j(cd));
  check("supplier: bill 10,000 before VAT less vendor credit 1,000 = 9,000 (mirror expense not counted)", aed.supplier.total === 9_000_00, j(aed.supplier));
  check("supplier paid 5,000 (half, before VAT), unpaid 4,000 after the credit", aed.supplier.paid === 5_000_00 && aed.supplier.unpaid === 4_000_00, j(aed.supplier));
  check("other: rent 20,000 + software 3,000 = 23,000 (the advance is not a P&L cost; rupee rent apart)", aed.other.total === 23_000_00, j(aed.other));
  check("other paid 20,000, unpaid 3,000", aed.other.paid === 20_000_00 && aed.other.unpaid === 3_000_00);
  check("expenses 412,000 + 5,500 + 9,000 + 23,000 = 449,500; net 135,000 − 449,500 = −314,500", aed.expenses.total === 449_500_00 && aed.netMinor === -314_500_00, j([aed.expenses.total, aed.netMinor]));
  check("margin = net ÷ income", aed.marginPct === Math.round((-314_500_00 / 135_000_00) * 1000) / 10, String(aed.marginPct));
  const inr = inv.sides.find((s) => s.currency === "INR")!;
  check("rupees apart: income 2,00,000 invoice + 2,50,000 paid in rupees; payroll 50,000; rent 30,000 — never in AED", inr.income.total === 450_000_00 && inr.payroll.total === 50_000_00 && inr.other.total === 30_000_00, j(inr));

  step("Invoice-based view, November");
  const invN = (await mp.getManagementProfit(org, ...NOV, "invoice")).sides.find((s) => s.currency === "AED");
  check("November: no payroll (October's pay is in October), no invoice, no costs", !invN || (invN.payroll.total === 0 && invN.income.total === 0 && invN.expenses.total === 0), j(invN));

  step("Collection-based view");
  const col = (await mp.getManagementProfit(org, ...OCT, "collection")).sides.find((s) => s.currency === "AED")!;
  check("October collections without VAT: 40,000 (September invoice) + 50,000 (half of October's) + 20,000 (tax invoice 21,000 − its 1,000) = 110,000; the rupee payment apart", col.income.total === 110_000_00, j(col.income));
  check("same costs as the invoice view", col.expenses.total === aed.expenses.total);
  const colN = (await mp.getManagementProfit(org, ...NOV, "collection")).sides.find((s) => s.currency === "AED")!;
  check("November collections: the second half, 50,000 without VAT", colN.income.total === 50_000_00, j(colN.income));
  const plCash = await reports.profitLossPeriod(org, ...NOV, "collected");
  check("the existing collected P&L is unchanged: November 52,500 with VAT", plCash.income.total === 52_500_00, j(plCash.income.total));

  step("Cash movement, November");
  const cash = await mp.getManagementProfit(org, ...NOV, "cash");
  const cN = cash.sides.find((s) => s.currency === "AED")!;
  check("money in 52,500 (the transfer in left out; the payroll reversal is not money in)", cN.income.total === 52_500_00, j(cN.income));
  check("money out: payroll 300,000 − 1,000 reversed = 299,000, bill 5,250, commission 1,000, other 200 + 100 duplicate = 305,550 (the transfer out left out)", cN.expenses.total === 305_550_00 && cN.payroll.total === 299_000_00 && cN.supplier.total === 5_250_00 && cN.commission.total === 1_000_00 && cN.other.total === 300_00, j(cN));
  check("net cash −253,050; nothing unpaid in it", cN.netMinor === -253_050_00 && cN.expenses.unpaid === 0, j(cN.netMinor));
  check("the duplicate line is counted and reported", cash.duplicates === 1);

  step("Totals equal their records");
  for (const line of ["income", "payroll", "commission", "supplier", "other", "expenses"] as const) {
    const r = await mp.managementLines(org, ...OCT, "invoice", line);
    const want = line === "expenses" ? aed.expenses.total : aed[line].total;
    check(`${line}: records add up to ${want / 100}`, r.totalMinor === want, j([r.totalMinor, want, r.rows.length]));
  }
  const months = (await mp.getManagementProfit(org, "2026-10-01", "2026-11-30", "invoice"));
  const both = months.sides.find((s) => s.currency === "AED")!;
  const mSum = months.months.reduce((n, m) => n + (m.sides.find((s) => s.currency === "AED")?.netMinor ?? 0), 0);
  check("month by month adds up to the period", mSum === both.netMinor, j([mSum, both.netMinor]));

  step("Root's feed");
  const root = await portal.managementProfitForPortal({ org, from: OCT[0], to: OCT[1], view: "invoice" }) as any;
  check("Root gets the same figures", typeof root === "object" && root.sides?.[0]?.currency === "AED" && root.sides[0].netMinor === aed.netMinor, j(root?.sides?.[0]));
  const rl = await portal.managementLinesForPortal({ org, from: OCT[0], to: OCT[1], view: "invoice", line: "payroll" }) as any;
  check("Root's payroll records: AED total 412,000, paid 300,000, unpaid 112,000; rupees apart", typeof rl === "object" && rl.totals?.amountMinor === 412_000_00 && rl.totals?.paidMinor === 300_000_00 && rl.totals?.unpaidMinor === 112_000_00 && (rl.otherCurrencies ?? []).some((c: any) => c.currency === "INR"), j(rl?.totals));
  check("a wrong view is refused", typeof (await portal.managementProfitForPortal({ org, from: OCT[0], to: OCT[1], view: "nope" })) === "string");

  step("Disclosures (deployment safeguards)");
  const notes = (v: "invoice" | "collection" | "cash") => mp.VIEW_NOTES[v].join(" ");
  for (const v of ["invoice", "collection"] as const) {
    check(`${v}: says payroll is the payable, paid/unpaid is as now, categories follow the P&L settings, typed commission may overlap, refunds and VAT`,
      /payable/.test(notes(v)) && /stands now/.test(notes(v)) && /category settings/.test(notes(v)) && /may overlap/.test(notes(v)) && /no refunds/.test(notes(v)) && /VAT/.test(notes(v)));
  }
  check("cash: says unmatched and duplicate lines are included, and refunds/VAT", /not matched/.test(notes("cash")) && /duplicate/.test(notes("cash")) && /no refunds/.test(notes("cash")));
  check("the notes reach Root", Array.isArray(root.notes) && root.notes.length === mp.VIEW_NOTES.invoice.length);

  step("Nothing written");
  check("payroll run, payouts and expenses unchanged by the reports", (await PayrollRun.collection.findOne({ _id: runOct }))!.amountPaidMinor === 350_000_00 && (await Expense.countDocuments({ organizationId: O })) === 8 /* 7 typed + the bill's mirror */, String(await Expense.countDocuments({ organizationId: O })));
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? `, ${failures} failed` : ""}`);
process.exit(failures ? 1 : 0);
