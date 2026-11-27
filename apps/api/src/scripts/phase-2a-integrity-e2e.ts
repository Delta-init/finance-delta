/**
 * Phase 2A transaction-integrity fixes (2026-11-27), against a scratch database through the real services:
 *
 *   F05  credit notes: applied credit survives a payment being edited and deleted; voiding a partly applied note gives
 *        the credit back; a credit never crosses currencies; two applies at once never over-apply a note.
 *   F22  commission: a record or payout is held by one payroll run only; one paid directly in the gap is never put on
 *        a payslip; a record on a run cannot be marked paid or cancelled by hand; taking it off the run frees it.
 *   F25  payroll bank lines: a backdated payment puts every later running balance right; a reversal does too; the
 *        same payment is never written to the bank twice.
 *
 * HRMS is stood in for (never called). Run through scripts/phase-2a-integrity-e2e.sh. Scratch database only.
 */
const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri) || /:27017\//.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1 (not 27017), got "${uri}"`);
  process.exit(1);
}
if (process.env.HRMS_API_URL) {
  console.error("Refusing to run: HRMS_API_URL must be empty — HRMS is stood in for here, never called.");
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { CreditNote } = await import("../modules/credit-note/credit-note.model");
const { CommissionRecord } = await import("../modules/commission/commission-record.model");
const { CsCommissionPayout } = await import("../modules/cs-commission/cs-commission-payout.model");
const { Employee } = await import("../modules/employee/employee.model");
const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { hrmsClient } = await import("../lib/hrms-client");
const credit = await import("../modules/credit-note/credit-note.service");
const invoices = await import("../modules/invoice/invoice.service");
const commission = await import("../modules/commission/commission.service");
const adjustments = await import("../modules/payroll/adjustments.service");
const payments = await import("../modules/payroll/payment.service");
const banking = await import("../modules/banking/banking.service");
const mongoose = (Organization as any).base;
const { Types } = mongoose;

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(s: string) { console.log(`\n\x1b[1m${s}\x1b[0m`); }
async function refused(fn: () => Promise<unknown>, re: RegExp): Promise<string> {
  try { await fn(); return "not refused"; } catch (e) { const m = (e as Error).message; return re.test(m) ? "" : m; }
}

await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
// The unique indexes the fixes lean on, built before anything is written (production has them already).
await Promise.all([BankTransaction.init(), PayrollRun.init(), CreditNote.init(), CommissionRecord.init(), CsCommissionPayout.init(), Invoice.init()]);
const now = new Date();
const d = (s: string) => new Date(`${s}T10:00:00Z`);
const O = (await Organization.collection.insertOne({ name: "Test Org", slug: `t-${Date.now()}`, baseCurrency: "AED", currency: "AED", createdAt: now, updatedAt: now })).insertedId;
const org = String(O);
const U = new Types.ObjectId();
const customerId = new Types.ObjectId();

// HRMS stood in for: every call answers as HRMS would, and is counted.
const hrmsCalls: string[] = [];
(hrmsClient as any).applyAdjustments = async (_o: string, _p: string, staged: any[]) => {
  hrmsCalls.push("apply");
  return { outcomes: staged.map((s: any) => ({ externalId: s.externalId, employeeId: s.employeeId, payslipId: "P", label: s.label, kind: s.kind, amount: s.amount, appliedAmount: s.amount, outstanding: 0, netBefore: 5000, netAfter: 5000 + s.amount })) };
};
(hrmsClient as any).removeAdjustment = async () => { hrmsCalls.push("remove"); return {}; };
for (const k of ["reversePayment", "settlePayments", "recordPayment", "notifyPayment"]) (hrmsClient as any)[k] = async () => { hrmsCalls.push(k); return {}; };

const invoice = async (n: string, total: number, paid: number[], currency = "AED") => {
  const payments = paid.map((a, i) => ({ _id: new Types.ObjectId(), method: "cash", amountMinor: a, paidOn: d(`2026-11-0${i + 1}`), reference: "" }));
  const sum = paid.reduce((x, y) => x + y, 0);
  const r = await Invoice.collection.insertOne({
    organizationId: O, invoiceNumber: n, customerId, customerName: "Client", salespersonId: U, salespersonName: "Sales", status: sum >= total ? "paid" : sum > 0 ? "partial" : "sent",
    currency, issueDate: d("2026-11-01"), dueDate: d("2026-12-01"), lineItems: [{ description: "Course", quantity: 1, unitPriceMinor: total, discountPct: 0, taxes: [], lineSubtotalMinor: total, discountMinor: 0, taxableMinor: total, taxTotalMinor: 0, lineTotalMinor: total }],
    subtotalMinor: total, taxTotalMinor: 0, totalMinor: total, amountPaidMinor: sum, balanceMinor: total - sum, payments,
    approval: { state: "approved" }, exchangeRate: 1, baseTotalMinor: total, createdAt: now, updatedAt: now,
  });
  return { id: String(r.insertedId), payments };
};
const inv = async (id: string) => (await Invoice.collection.findOne({ _id: new Types.ObjectId(id) })) as any;
const note = async (invoiceId: string, total: number, currency = "AED") => {
  const r = await CreditNote.collection.insertOne({
    organizationId: O, creditNoteNumber: `CN-${Math.random().toString(36).slice(2, 8)}`, invoiceId: new Types.ObjectId(invoiceId), invoiceNumber: "X",
    customerId, customerName: "Client", reason: "Discount", status: "issued", lineItems: [], subtotalMinor: total, taxTotalMinor: 0, totalMinor: total,
    amountAppliedMinor: 0, currency, issuedAt: now, createdAt: now, updatedAt: now,
  });
  return String(r.insertedId);
};

try {
  // ── F05 ──────────────────────────────────────────────────────────────────
  step("F05 — credit note integrity");
  const a = await invoice("INV-A", 100000, [30000, 20000]);
  const cnA = await note(a.id, 20000);
  await credit.applyCreditNote(org, cnA, {} as never);
  let x = await inv(a.id);
  check("applying 200 on a 1,000 invoice with 500 paid: settled 700, balance 300, part paid; no payment added",
    x.amountPaidMinor === 70000 && x.balanceMinor === 30000 && x.status === "partial" && x.payments.length === 2, JSON.stringify([x.amountPaidMinor, x.balanceMinor, x.status, x.payments.length]));
  const cnDoc: any = await CreditNote.collection.findOne({ _id: new Types.ObjectId(cnA) });
  check("the note records where the credit went", cnDoc.applications?.length === 1 && String(cnDoc.applications[0].invoiceId) === a.id && cnDoc.applications[0].amountMinor === 20000 && cnDoc.status === "applied");

  await invoices.updatePayment(org, a.id, String(a.payments[0]!._id), { method: "cash", amountMinor: 40000, paidOn: "2026-11-01", reference: "" } as never);
  x = await inv(a.id);
  check("editing a payment (300 → 400) keeps the credit: settled 800, balance 200", x.amountPaidMinor === 80000 && x.balanceMinor === 20000 && x.status === "partial", JSON.stringify([x.amountPaidMinor, x.balanceMinor, x.status]));
  check("a payment edit that would overpay with the credit counted is refused",
    (await refused(() => invoices.updatePayment(org, a.id, String(a.payments[0]!._id), { method: "cash", amountMinor: 70000, paidOn: "2026-11-01", reference: "" } as never), /exceed the invoice total/)) === "");

  await invoices.deletePayment(org, a.id, String(a.payments[1]!._id));
  x = await inv(a.id);
  check("deleting a payment (200) keeps the credit: settled 600 (400 paid + 200 credit), balance 400", x.amountPaidMinor === 60000 && x.balanceMinor === 40000 && x.status === "partial", JSON.stringify([x.amountPaidMinor, x.balanceMinor, x.status]));
  await invoices.deletePayment(org, a.id, String(a.payments[0]!._id));
  x = await inv(a.id);
  check("deleting the last payment still leaves the credit: settled 200, part paid (not 'sent')", x.amountPaidMinor === 20000 && x.balanceMinor === 80000 && x.status === "partial", JSON.stringify([x.amountPaidMinor, x.balanceMinor, x.status]));

  step("F05 — voiding a partly applied note gives the credit back");
  const b = await invoice("INV-B", 100000, [50000]);
  const c = await invoice("INV-C", 30000, [0].filter(Boolean));
  const cnB = await note(b.id, 60000);
  await credit.applyCreditNote(org, cnB, {} as never);                            // 500 left on B: applies 500
  check("first apply: B settled in full by 500 of the 600 credit", (await inv(b.id)).status === "paid" && (await inv(b.id)).balanceMinor === 0);
  await credit.applyCreditNote(org, cnB, { targetInvoiceId: c.id } as never);     // remaining 100 → C
  check("rest of the credit (100) applied to another invoice C", (await inv(c.id)).amountPaidMinor === 10000 && (await inv(c.id)).balanceMinor === 20000);
  // Applied in full now — a fully applied note stays un-voidable, as before.
  check("a fully applied note still cannot be voided (unchanged rule)", (await refused(() => credit.voidCreditNote(org, cnB), /cannot be voided/)) === "");
  const d1 = await invoice("INV-D", 50000, [10000]);
  const cnD = await note(d1.id, 80000);
  await credit.applyCreditNote(org, cnD, {} as never);                            // 400 of 800 applied, note stays issued
  check("partly applied note: D settled in full, note still issued with 400 left", (await inv(d1.id)).status === "paid" && ((await CreditNote.collection.findOne({ _id: new Types.ObjectId(cnD) })) as any).status === "issued");
  await credit.voidCreditNote(org, cnD);
  x = await inv(d1.id);
  check("voiding it reverses its credit on D: back to 100 paid, 400 owed, part paid", x.amountPaidMinor === 10000 && x.balanceMinor === 40000 && x.status === "partial", JSON.stringify([x.amountPaidMinor, x.balanceMinor, x.status]));
  check("the voided note is voided", ((await CreditNote.collection.findOne({ _id: new Types.ObjectId(cnD) })) as any).status === "voided");

  step("F05 — older notes (no list of applications) count on their own invoice");
  const e = await invoice("INV-E", 100000, [40000]);
  await CreditNote.collection.insertOne({ organizationId: O, creditNoteNumber: "CN-OLD", invoiceId: new Types.ObjectId(e.id), invoiceNumber: "INV-E", customerId, customerName: "Client", reason: "Old", status: "applied", lineItems: [], subtotalMinor: 10000, taxTotalMinor: 0, totalMinor: 10000, amountAppliedMinor: 10000, currency: "AED", createdAt: now, updatedAt: now });
  await Invoice.collection.updateOne({ _id: new Types.ObjectId(e.id) }, { $set: { amountPaidMinor: 50000, balanceMinor: 50000 } });
  await invoices.deletePayment(org, e.id, String(e.payments[0]!._id));
  x = await inv(e.id);
  check("deleting the payment keeps the older note's 100 credit (it used to be wiped)", x.amountPaidMinor === 10000 && x.balanceMinor === 90000 && x.status === "partial", JSON.stringify([x.amountPaidMinor, x.balanceMinor]));

  step("F05 — currency and concurrency");
  const usd = await invoice("INV-USD", 50000, [], "USD");
  const cnAed = await note(e.id, 5000, "AED");
  check("an AED credit cannot be applied to a USD invoice", (await refused(() => credit.applyCreditNote(org, cnAed, { targetInvoiceId: usd.id } as never), /own currency/)) === "");
  check("…and nothing changed on either", (await inv(usd.id)).amountPaidMinor === 0 && ((await CreditNote.collection.findOne({ _id: new Types.ObjectId(cnAed) })) as any).amountAppliedMinor === 0);
  const f = await invoice("INV-F", 100000, []);
  const g = await invoice("INV-G", 100000, []);
  const cnF = await note(f.id, 30000);
  const both = await Promise.allSettled([credit.applyCreditNote(org, cnF, {} as never), credit.applyCreditNote(org, cnF, { targetInvoiceId: g.id } as never)]);
  const fDoc: any = await CreditNote.collection.findOne({ _id: new Types.ObjectId(cnF) });
  const settled = (await inv(f.id)).amountPaidMinor + (await inv(g.id)).amountPaidMinor;
  check("two applies of one 300 note at once: the note is never over-applied", fDoc.amountAppliedMinor === 30000 && settled === 30000 && both.some((r) => r.status === "fulfilled"),
    JSON.stringify({ applied: fDoc.amountAppliedMinor, settled, results: both.map((r) => r.status) }));

  // ── F22 ──────────────────────────────────────────────────────────────────
  step("F22 — commission held by one payroll run only");
  const sales = new Types.ObjectId();
  const empId = new Types.ObjectId();
  await Employee.collection.insertOne({ _id: empId, organizationId: O, hrmsOrgId: "h1", hrmsEmployeeId: "E1", userId: sales, email: "cs@example.test", name: "Employee", createdAt: now, updatedAt: now });
  const runOf = async (number: string, period: string) => (await PayrollRun.collection.insertOne({
    organizationId: O, source: "hrms", hrmsOrgId: "h1", runNumber: number, period, currency: "AED", status: "imported",
    lines: [{ _id: new Types.ObjectId(), hrmsPayslipId: `P-${number}`, hrmsEmployeeId: "E1", employeeCode: "E1", name: "Employee", currency: "AED", grossMinor: 500000, deductionsMinor: 0, netFromHrmsMinor: 500000, adjustmentsMinor: 0, payableMinor: 500000, amountPaidMinor: 0, status: "pending", earnings: [], deductions: [], bank: {} }],
    adjustments: [], payments: [], amountPaidMinor: 0, createdAt: now, updatedAt: now,
  })).insertedId;
  const runA = String(await runOf("PR-A", "2026-11"));
  const runB = String(await runOf("PR-B", "2026-12"));
  const rec = (await CommissionRecord.collection.insertOne({ organizationId: O, structureId: new Types.ObjectId(), salespersonId: sales, salespersonName: "Sales", invoiceId: new Types.ObjectId(), invoiceNumber: "INV-COM", invoiceTotalMinor: 100000, commissionMinor: 5000, basis: "payment_received", status: "earned", createdAt: now, updatedAt: now })).insertedId;
  const pullA: any = await adjustments.pullCommissions(org, runA, { userId: String(U) });
  const r1: any = await CommissionRecord.collection.findOne({ _id: rec });
  check("run A pulls the record and holds it", pullA.pulled === 1 && String(r1.payrollRunId) === runA, JSON.stringify(pullA));
  const pullB: any = await adjustments.pullCommissions(org, runB, { userId: String(U) });
  check("run B does not pull the same record", pullB.pulled === 0 && String(((await CommissionRecord.collection.findOne({ _id: rec })) as any).payrollRunId) === runA, JSON.stringify(pullB));
  check("a record on a run cannot be marked paid by hand", (await refused(() => commission.markPaid(org, { recordIds: [String(rec)], paidAt: "2026-11-20", notes: "manual" } as never), /on a payroll run/)) === "");
  check("…nor cancelled", (await refused(() => commission.cancelRecord(org, String(rec)), /payroll run/)) === "");
  const runADoc: any = await PayrollRun.findById(runA);
  const ext = runADoc.adjustments.find((z: any) => z.source === "commission").externalId;
  await adjustments.removeAdjustment(org, runA, ext);
  check("taking it off run A frees it", ((await CommissionRecord.collection.findOne({ _id: rec })) as any).payrollRunId === null);
  const pullB2: any = await adjustments.pullCommissions(org, runB, { userId: String(U) });
  check("…and run B can then pull it", pullB2.pulled === 1 && String(((await CommissionRecord.collection.findOne({ _id: rec })) as any).payrollRunId) === runB);

  step("F22 — a payout paid directly in the gap never reaches a payslip");
  const runC = String(await runOf("PR-C", "2027-01"));
  const payout = (await CsCommissionPayout.collection.insertOne({ key: "cs-1", organizationId: O, kind: "bonus", period: "2026-11", lastMonth: "2026-11", recipientId: "r1", personName: "CS", email: "cs@example.test", currency: "AED", amountMinor: 7000, amountUsd: 19, state: "approved", approvedById: U, approvedByName: "Manager", approvedAt: now, payrollRunId: null, createdAt: now, updatedAt: now })).insertedId;
  // Paid directly just after the pull reads it: the direct payment's own atomic claim wins.
  const realFind = CsCommissionPayout.find.bind(CsCommissionPayout);
  (CsCommissionPayout as any).find = (...args: any[]) => {
    const q = realFind(...args);
    const realLean = q.lean.bind(q);
    q.lean = (...la: any[]) => realLean(...la).then(async (rows: any) => {
      await CsCommissionPayout.collection.updateOne({ _id: payout, state: "approved", payrollRunId: null }, { $set: { state: "paid", paidOn: now } });
      return rows;
    });
    return q;
  };
  const before = hrmsCalls.filter((c) => c === "apply").length;
  const gap = await refused(() => adjustments.pullCsCommission(org, runC, { userId: String(U) }), /paid, changed or taken/);
  (CsCommissionPayout as any).find = realFind;
  const p1: any = await CsCommissionPayout.collection.findOne({ _id: payout });
  const runCDoc: any = await PayrollRun.collection.findOne({ _id: new Types.ObjectId(runC) });
  check("the pull stops: nothing claimed, nothing sent to HRMS, nothing on the run", gap === "" && p1.payrollRunId === null && p1.state === "paid" && hrmsCalls.filter((c) => c === "apply").length === before && runCDoc.adjustments.length === 0,
    JSON.stringify({ gap, payrollRunId: p1.payrollRunId, state: p1.state, adjustments: runCDoc.adjustments.length }));
  const p2 = (await CsCommissionPayout.collection.insertOne({ key: "cs-2", organizationId: O, kind: "bonus", period: "2026-11", lastMonth: "2026-11", recipientId: "r1", personName: "CS", email: "cs@example.test", currency: "AED", amountMinor: 3000, amountUsd: 8, state: "approved", approvedById: U, approvedByName: "Manager", approvedAt: now, payrollRunId: null, createdAt: now, updatedAt: now })).insertedId;
  const pullC: any = await adjustments.pullCsCommission(org, runC, { userId: String(U) });
  check("a payout pulled normally is held by the run", pullC.pulled === 1 && String(((await CsCommissionPayout.collection.findOne({ _id: p2 })) as any).payrollRunId) === runC);
  const direct = await CsCommissionPayout.updateOne({ _id: p2, state: "approved", payrollRunId: null }, { $set: { state: "paid" } });
  check("…so the direct payment's own claim cannot take it", direct.modifiedCount === 0);
  const runD = String(await runOf("PR-D", "2027-02"));
  const failing = hrmsClient.applyAdjustments;
  const p3 = (await CsCommissionPayout.collection.insertOne({ key: "cs-3", organizationId: O, kind: "bonus", period: "2026-11", lastMonth: "2026-11", recipientId: "r1", personName: "CS", email: "cs@example.test", currency: "AED", amountMinor: 1000, amountUsd: 3, state: "approved", approvedById: U, approvedByName: "Manager", approvedAt: now, payrollRunId: null, createdAt: now, updatedAt: now })).insertedId;
  (hrmsClient as any).applyAdjustments = async () => { throw new Error("HRMS is down"); };
  const down = await refused(() => adjustments.pullCsCommission(org, runD, { userId: String(U) }), /HRMS is down/);
  (hrmsClient as any).applyAdjustments = failing;
  check("HRMS refusing: the claim is given back", down === "" && ((await CsCommissionPayout.collection.findOne({ _id: p3 })) as any).payrollRunId === null);

  // ── F25 ──────────────────────────────────────────────────────────────────
  step("F25 — payroll bank lines and running balances");
  const acc = (await BankAccount.collection.insertOne({ organizationId: O, accountName: "Main", accountType: "current", currency: "AED", openingBalanceMinor: 1000000, openingDate: d("2026-10-01"), currentBalanceMinor: 1000000, isActive: true, createdAt: now, updatedAt: now })).insertedId;
  await BankTransaction.collection.insertOne({ organizationId: O, accountId: acc, accountName: "Main", currency: "AED", date: d("2026-11-10"), description: "Rent", amountMinor: -100000, type: "debit", runningBalanceMinor: 900000, source: "manual", status: "unmatched", matches: [], createdAt: now, updatedAt: now });
  await banking.recalculateRunningBalances(org, acc);
  const manual = (await PayrollRun.collection.insertOne({
    organizationId: O, source: "manual", hrmsOrgId: "manual", runNumber: "PR-M", period: "2026-10", currency: "AED", status: "approved",
    lines: [{ _id: new Types.ObjectId(), hrmsPayslipId: "M1", hrmsEmployeeId: "M1", employeeCode: "", name: "Staff", currency: "AED", grossMinor: 200000, deductionsMinor: 0, netFromHrmsMinor: 200000, adjustmentsMinor: 0, payableMinor: 200000, amountPaidMinor: 0, status: "pending", earnings: [], deductions: [], bank: {} }],
    adjustments: [], payments: [], amountPaidMinor: 0, createdAt: now, updatedAt: now,
  })).insertedId;
  const pay = () => payments.payRun(org, String(manual), { bankAccountId: String(acc), method: "bank_transfer", paidOn: "2026-11-01", reference: "SAL-OCT" }, { userId: String(U) });
  const twice = await Promise.allSettled([pay(), pay()]);
  const lines = await BankTransaction.collection.find({ accountId: acc }).sort({ date: 1, createdAt: 1 }).toArray() as any[];
  const payrollLines = lines.filter((l) => l.matches?.some((m: any) => m.type === "payroll"));
  check("paying the same run twice at once: one payment reaches the bank, the other is refused",
    payrollLines.length === 1 && twice.filter((t) => t.status === "fulfilled").length === 1, JSON.stringify({ payrollLines: payrollLines.length, results: twice.map((t) => t.status === "rejected" ? (t.reason as Error).message : "ok") }));
  const byDesc = (s: string) => lines.find((l) => String(l.description).startsWith(s));
  let account: any = await BankAccount.collection.findOne({ _id: acc });
  check("backdated payment (1 Nov, 2,000): its line runs 8,000, the later rent line (10 Nov) now runs 7,000, the account 7,000",
    byDesc("Payroll")?.runningBalanceMinor === 800000 && byDesc("Rent")?.runningBalanceMinor === 700000 && account.currentBalanceMinor === 700000,
    JSON.stringify({ payroll: byDesc("Payroll")?.runningBalanceMinor, rent: byDesc("Rent")?.runningBalanceMinor, account: account.currentBalanceMinor }));
  const runM: any = await PayrollRun.findById(manual);
  const pid = runM.payments[0].paymentId;
  await payments.reversePayment(org, String(manual), pid, "Bank returned the transfer");
  account = await BankAccount.collection.findOne({ _id: acc });
  const after = await BankTransaction.collection.find({ accountId: acc }).toArray() as any[];
  check("reversal: a credit line, the account back to 9,000", after.some((l) => String(l.description).startsWith("Reversal")) && account.currentBalanceMinor === 900000, JSON.stringify({ account: account.currentBalanceMinor }));
  const again: any = await payments.reversePayment(org, String(manual), pid, "again");
  const reversals = await BankTransaction.collection.countDocuments({ accountId: acc, description: { $regex: "^Reversal" } });
  const accAgain: any = await BankAccount.collection.findOne({ _id: acc });
  check("reversing it again changes nothing: 'already reversed', one reversal line, balance still 9,000", again?.alreadyReversed === true && reversals === 1 && accAgain.currentBalanceMinor === 900000, JSON.stringify({ again, reversals }));
} finally {
  await mongoose.connection.dropDatabase().catch(() => undefined);
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
