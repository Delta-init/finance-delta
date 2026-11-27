/**
 * Phase 6 financial controls (2026-11-28), against a scratch database through the real services: approvals from
 * finance's Approvals service plus late entries, draft credit notes and unapproved payroll, their age and overdue
 * mark; exceptions by severity with money at risk = confirmed only; liquidity equal to Phase 4; reconciliation figures
 * equal to Phase 5; expense, payroll and VAT controls; month-by-month closing readiness from records; audit from what
 * records carry, "not recorded" where nothing is; AED and INR apart; the dashboard equal to the reports; records adding
 * up; nothing written.
 *
 * Run through scripts/phase-6-controls-e2e.sh. Scratch database only.
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
const { Vendor } = await import("../modules/vendor/vendor.model");
const { Expense } = await import("../modules/expense/expense.model");
const { PayrollRun } = await import("../modules/payroll/payroll-run.model");
const { CrmCommissionPayout } = await import("../modules/crm-commission/crm-commission-payout.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { LateEntryModel } = await import("../modules/late-entry/late-entry.model");
const fc = await import("../modules/reports/controls.service");
const fp = await import("../modules/reports/financial-position.service");
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
type Side = { currency: string; sections: { key: string; lines: { key: string; label: string; amountMinor: number; count: number }[]; totalMinor: number }[]; totals: { key: string; label: string; amountMinor: number }[] };
const side = (r: { sides: Side[] }, c = "AED") => r.sides.find((s) => s.currency === c)!;
const tot = (s: Side | undefined, k: string) => s?.totals.find((t) => t.key === k)?.amountMinor;
const ln = (s: Side | undefined, key: string) => s?.sections.flatMap((x) => x.lines).find((l) => l.key === key);
const sec = (s: Side | undefined, key: string) => s?.sections.find((x) => x.key === key)?.totalMinor ?? 0;

await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const now = new Date();
const ago = (days: number) => new Date(Date.now() - days * 86_400_000);
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const O = (await Organization.collection.insertOne({ name: "Test Org", slug: `t-${Date.now()}`, baseCurrency: "AED", currency: "AED", createdAt: now, updatedAt: now })).insertedId;
const org = String(O);
const U = new Types.ObjectId(), customerId = new Types.ObjectId();
const today = now.toISOString().slice(0, 10);
const thisMonth = today.slice(0, 7);
const prev = (() => { const x = new Date(`${thisMonth}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() - 1); return x.toISOString().slice(0, 7); })();
const prevEnd = new Date(Date.parse(`${thisMonth}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const P = [`${prev}-01`, today] as const;

try {
  step("Setting up");
  // Approvals waiting: an expense for 5 days (overdue), a bill for 1 day, an INR expense, a payroll run, a late entry, a draft credit note.
  await Expense.collection.insertMany([
    { organizationId: O, expenseNumber: "EXP-WAIT", category: "software_it", subcategory: null, description: "Licence", expenseDate: ago(5), paidOn: null, amountMinor: 1_000_00, taxMinor: 0, totalMinor: 1_000_00, currency: "AED", status: "submitted", submittedById: U, submittedByName: "Clerk", createdAt: ago(5), updatedAt: ago(5) },
    { organizationId: O, expenseNumber: "EXP-WAIT-INR", category: "software_it", subcategory: null, description: "Rupee licence", expenseDate: ago(2), paidOn: null, amountMinor: 50_000_00, taxMinor: 0, totalMinor: 50_000_00, currency: "INR", status: "submitted", submittedById: U, submittedByName: "Clerk", createdAt: ago(2), updatedAt: ago(2) },
    // Paid, no attachment, no reference; late-recorded (entered 40 days after its date)
    { organizationId: O, expenseNumber: "EXP-NODOC", category: "rent_utilities", subcategory: null, description: "Rent", expenseDate: d(`${prev}-02`), paidOn: d(`${prev}-02`), amountMinor: 10_000_00, taxMinor: 0, totalMinor: 10_000_00, currency: "AED", status: "approved", paymentMethod: "bank_transfer", reference: "", attachments: [], bankTransactionId: new Types.ObjectId(), submittedById: U, createdAt: new Date(Date.parse(`${prev}-02T12:00:00Z`) + 40 * 86_400_000), updatedAt: now },
    // A month of marketing far above the 3 months before
    { organizationId: O, expenseNumber: "EXP-MK", category: "advertising_marketing", subcategory: null, description: "Ads", expenseDate: d(`${prev}-05`), paidOn: d(`${prev}-05`), amountMinor: 20_000_00, taxMinor: 0, totalMinor: 20_000_00, currency: "AED", status: "approved", paymentMethod: "cash", reference: "", attachments: [{ name: "a.pdf", url: "u" }], submittedById: U, createdAt: d(`${prev}-05`), updatedAt: d(`${prev}-05`) },
    // A typed commission naming a payee who has a payout
    { organizationId: O, expenseNumber: "EXP-COM", category: "sales_commission", subcategory: null, description: "Commission Rep", expenseDate: d(`${prev}-20`), paidOn: d(`${prev}-20`), amountMinor: 500_00, taxMinor: 0, totalMinor: 500_00, currency: "AED", status: "approved", paymentMethod: "cash", reference: "", attachments: [{ name: "c.pdf", url: "u" }], submittedById: U, createdAt: d(`${prev}-20`), updatedAt: d(`${prev}-20`) },
  ]);
  for (const m of [3, 4, 5]) { const x = new Date(`${prev}-05T12:00:00Z`); x.setUTCMonth(x.getUTCMonth() - (m - 2)); await Expense.collection.insertOne({ organizationId: O, expenseNumber: `EXP-MK${m}`, category: "advertising_marketing", subcategory: null, description: "Ads", expenseDate: x, paidOn: x, amountMinor: 4_000_00, taxMinor: 0, totalMinor: 4_000_00, currency: "AED", status: "approved", paymentMethod: "cash", reference: "", attachments: [{ name: "a.pdf", url: "u" }], submittedById: U, createdAt: x, updatedAt: x }); }
  const vendorNoVat = (await Vendor.collection.insertOne({ organizationId: O, name: "No-VAT Supplier", vatNumber: "", currency: "AED", status: "active", createdAt: now, updatedAt: now })).insertedId;
  await Bill.collection.insertMany([
    { organizationId: O, billNumber: "BILL-WAIT", vendorId: vendorNoVat, vendorName: "No-VAT Supplier", billDate: ago(1), dueDate: new Date(Date.now() + 20 * 86_400_000), status: "pending_approval", currency: "AED", lineItems: [], subtotalMinor: 2_000_00, taxTotalMinor: 100_00, totalMinor: 2_100_00, amountPaidMinor: 0, balanceMinor: 2_100_00, payments: [], createdAt: ago(1), updatedAt: ago(1) },
    { organizationId: O, billNumber: "BILL-OVERDUE", vendorId: vendorNoVat, vendorName: "No-VAT Supplier", billDate: d(`${prev}-03`), dueDate: d(`${prev}-10`), status: "approved", currency: "AED", lineItems: [{ description: "x", quantity: 1, unitPriceMinor: 3_000_00, discountPct: 0, taxPct: 5, lineTotalMinor: 3_150_00 }], subtotalMinor: 3_000_00, taxTotalMinor: 150_00, totalMinor: 3_150_00, amountPaidMinor: 0, balanceMinor: 3_150_00, payments: [], createdAt: d(`${prev}-03`), updatedAt: d(`${prev}-03`) },
  ]);
  const lA = new Types.ObjectId(), lB = new Types.ObjectId();
  const pl = (id: unknown, name: string, payable: number, paid: number, status = "pending") => ({ _id: id, hrmsPayslipId: `P-${name}`, hrmsEmployeeId: `E-${name}`, employeeCode: name, name, earnings: [], deductions: [], grossMinor: payable, deductionsMinor: 0, netFromHrmsMinor: payable, adjustmentsMinor: 0, payableMinor: payable, amountPaidMinor: paid, payable: true, status });
  await PayrollRun.collection.insertMany([
    { organizationId: O, source: "hrms", hrmsOrgId: "H1", runNumber: "PAY-PREV", period: prev, currency: "AED", status: "partially_paid", lines: [pl(lA, "A", 8_000_00, 8_000_00, "paid"), pl(lB, "B", 2_000_00, 0, "on_hold")], adjustments: [], payments: [{ _id: new Types.ObjectId(), paymentId: "p1", method: "bank_transfer", paidOn: d(`${prev}-28`), amountMinor: 8_000_00, currency: "AED", allocations: [{ lineId: lA, amountMinor: 8_000_00 }] }, { _id: new Types.ObjectId(), paymentId: "p2", method: "bank_transfer", paidOn: d(`${prev}-28`), amountMinor: 300_00, currency: "AED", allocations: [], reversedAt: d(`${prev}-29`), reversalReason: "wrong account" }], deletedPayments: [{ paymentId: "p0", amountMinor: 100_00, currency: "AED", paidOn: d(`${prev}-27`), reason: "duplicate entry", deletedAt: d(`${prev}-27`), deletedByName: "Payroll Officer" }], importedAt: d(`${prev}-25`), createdAt: d(`${prev}-25`), updatedAt: now },
    { organizationId: O, source: "hrms", hrmsOrgId: "H2", runNumber: "PAY-NOW", period: thisMonth, currency: "AED", status: "imported", payableMinor: 6_000_00, lines: [pl(new Types.ObjectId(), "C", 6_000_00, 0)], adjustments: [], payments: [], importedAt: ago(4), createdAt: ago(4), updatedAt: ago(4) },
  ]);
  await CrmCommissionPayout.collection.insertMany([
    { key: "k1", organizationId: O, crm: "sales", crmName: "Sales", month: prev, userId: "u", personName: "Rep One", currency: "AED", amountMinor: 1_500_00, state: "approved", approvedById: U, approvedAt: now, createdAt: now, updatedAt: now },
    { key: "k2", organizationId: O, crm: "sales", crmName: "Sales", month: prev, userId: "u", personName: "Rep One", currency: "AED", amountMinor: 700_00, state: "paid", expenseId: new Types.ObjectId(), payrollRunId: new Types.ObjectId(), approvedById: U, approvedAt: now, createdAt: now, updatedAt: now }, // paid twice
  ]);
  await LateEntryModel.collection.insertOne({ organizationId: O, kind: "expense", refId: new Types.ObjectId(), number: "EXP-OLD", title: "Old receipt", amountMinor: 250_00, currency: "AED", date: d(`${prev}-01`), reason: "found late", state: "pending", enteredById: U, enteredByName: "Clerk", createdAt: ago(10), updatedAt: ago(10) });
  await CreditNote.collection.insertOne({ organizationId: O, creditNoteNumber: "CN-DRAFT", invoiceId: new Types.ObjectId(), invoiceNumber: "X", customerId, customerName: "Client", reason: "r", status: "draft", lineItems: [], subtotalMinor: 400_00, taxTotalMinor: 20_00, totalMinor: 420_00, amountAppliedMinor: 0, currency: "AED", createdAt: ago(2), updatedAt: ago(2) });
  // Exceptions: one confirmed (overpaid invoice), suspected (duplicate expenses)
  await Invoice.collection.insertOne({ organizationId: O, invoiceNumber: "I-OVER", customerId, customerName: "Client", status: "paid", currency: "AED", issueDate: d(`${prev}-08`), dueDate: d(`${prev}-08`), lineItems: [], subtotalMinor: 1_000_00, taxTotalMinor: 0, totalMinor: 1_000_00, amountPaidMinor: 1_300_00, balanceMinor: -300_00, payments: [{ _id: new Types.ObjectId(), method: "cash", amountMinor: 1_300_00, paidOn: d(`${prev}-09`), reference: "R1" }], exchangeRate: 1, baseTotalMinor: 1_000_00, createdAt: now, updatedAt: now });
  await Invoice.collection.insertOne({ organizationId: O, invoiceNumber: "I-VOIDED", customerId, customerName: "Client", status: "void", currency: "AED", issueDate: d(`${prev}-11`), dueDate: d(`${prev}-11`), lineItems: [], subtotalMinor: 900_00, taxTotalMinor: 0, totalMinor: 900_00, amountPaidMinor: 0, balanceMinor: 900_00, payments: [], exchangeRate: 1, baseTotalMinor: 900_00, createdAt: d(`${prev}-11`), updatedAt: ago(1) });
  await Expense.collection.insertMany([0, 1].map((k) => ({ organizationId: O, expenseNumber: `EXP-DUP${k}`, category: "office_supplies", subcategory: null, description: "Paper", expenseDate: d(`${prev}-12`), paidOn: d(`${prev}-12`), amountMinor: 75_00, taxMinor: 0, totalMinor: 75_00, currency: "AED", status: "approved", paymentMethod: "cash", reference: "", attachments: [{ name: "p.pdf", url: "u" }], submittedById: U, createdAt: d(`${prev}-12`), updatedAt: d(`${prev}-12`) })));
  // Bank: one account, no reconciliation
  const MAIN = (await BankAccount.collection.insertOne({ organizationId: O, accountName: "Main", accountType: "current", currency: "AED", openingBalanceMinor: 30_000_00, openingDate: d(`${prev}-01`), currentBalanceMinor: 30_000_00, isActive: true, createdAt: now, updatedAt: now })).insertedId;
  await BankTransaction.collection.insertOne({ organizationId: O, accountId: MAIN, accountName: "Main", currency: "AED", date: d(`${prev}-15`), description: "x", reference: "", amountMinor: -500_00, type: "debit", runningBalanceMinor: 0, source: "manual", status: "unmatched", matches: [], transfer: null, settlement: null, createdAt: d(`${prev}-15`), updatedAt: d(`${prev}-15`) });
  await BankAccount.collection.updateOne({ _id: MAIN }, { $set: { currentBalanceMinor: 29_500_00 } });

  // ── Approvals ──────────────────────────────────────────────────────────────
  step("Approval monitoring");
  const ap = await fc.controlsReport(org, "approvals", ...P);
  const a = side(ap as any);
  const pending = ap.rows.filter((r) => r.section === "pending");
  check("from finance's Approvals service: the waiting expense, bill and payroll run; plus the late entry and the draft credit note", ["expense", "bill", "payroll", "late_entry", "credit_note"].every((k) => pending.some((r) => r.line === k)), j(pending.map((r) => r.line)));
  check("amounts and statuses as in the source records (expense 1,000, bill 2,100, payroll 6,000, late entry 250, credit note 420)", ln(a, "pending:expense")?.amountMinor === 1_000_00 && ln(a, "pending:bill")?.amountMinor === 2_100_00 && ln(a, "pending:payroll")?.amountMinor === 6_000_00 && ln(a, "pending:late_entry")?.amountMinor === 250_00 && ln(a, "pending:credit_note")?.amountMinor === 420_00, j(a.sections.find((s) => s.key === "pending")));
  const exp1 = pending.find((r) => r.line === "expense" && r.currency === "AED");
  check("ageing: the expense waited 5 days → 4–7 days, overdue; the bill 1 day → within 3 days; late entry 10 days → 8–30", exp1?.band === "a4_7" && exp1?.kind === "Overdue" && pending.find((r) => r.line === "bill")?.band === "a0_3" && pending.find((r) => r.line === "late_entry")?.band === "a8_30", j(pending.map((r) => [r.line, r.currency, r.ageDays, r.band, r.kind])));
  check("who decides: the permission (expense:approve), not a made-up person", pending.find((r) => r.line === "expense")?.action === "Expense approver (expense:approve)");
  check("department where recorded, otherwise 'Not recorded'", pending.find((r) => r.line === "bill")?.account === "Not recorded" && !!pending.find((r) => r.line === "expense")?.account);
  check("INR approval on its own side", ln(side(ap as any, "INR"), "pending:expense")?.amountMinor === 50_000_00);
  check("HRMS-backed kinds that cannot be read are said so (no HRMS here)", ap.warnings.some((w) => /Approvals not readable/.test(w)) || ap.warnings.length === 0, j(ap.warnings));

  // ── Risks ──────────────────────────────────────────────────────────────────
  step("Risks and exceptions");
  const exc = await rc.reconciliationReport(org, "exceptions", ...P);
  const rk = await fc.controlsReport(org, "risks", ...P);
  const k = side(rk as any);
  const confirmedSum = exc.rows.filter((r) => r.currency === "AED" && r.confidence === "confirmed").reduce((t, r) => t + Math.abs(r.amountMinor), 0);
  check("money at risk = Phase 5's confirmed discrepancies only, each once", tot(k, "exposure") === confirmedSum && confirmedSum > 0, j([tot(k, "exposure"), confirmedSum]));
  check("severity and status preserved from RC-08 (critical overpaid invoice; suspected duplicate expense)", rk.rows.some((r) => r.section === "sev_critical" && /Overpaid/.test(r.exception ?? "")) && rk.rows.some((r) => r.section === "conf_suspected" && /duplicate expense/i.test(r.exception ?? "")));
  check("suspected and missing totals are not added (sections without a total; counts given instead)", (k.sections.find((s) => s.key === "conf_suspected") as any) !== undefined && !(rk.sides[0]!.totals as any[]).some((t) => /suspected/i.test(t.label) && t.amountMinor !== 0));

  // ── Liquidity ──────────────────────────────────────────────────────────────
  step("Payment and liquidity");
  const liq = await fc.controlsReport(org, "liquidity", ...P);
  const l = side(liq as any);
  const cash = side((await fp.financialReport(org, "cash", ...P)) as any);
  const obl = side((await fp.financialReport(org, "obligations", ...P)) as any);
  check("available recorded cash = Phase 4's estimated available", tot(l, "available") === tot(cash, "available"), j([tot(l, "available"), tot(cash, "available")]));
  check("obligations: due-dated split from undated; all together = Phase 4's total", sec(l, "due_soon") + sec(l, "no_due") + sec(l, "due_later") === tot(obl, "total"), j([sec(l, "due_soon"), sec(l, "no_due"), sec(l, "due_later"), tot(obl, "total")]));
  check("overdue supplier payment 3,150 (BILL-OVERDUE)", tot(l, "overdue_bills") === 3_150_00);
  check("shortfall = available − (due within 30 days + no due date)", tot(l, "shortfall") === (tot(l, "available") ?? 0) - sec(l, "due_soon") - sec(l, "no_due"));
  check("reconciled balance kept apart: none confirmed", /none/i.test(l.totals.find((t) => t.key === "confirmed")?.label ?? "") && tot(l, "confirmed") === 0);

  // ── Expenses ───────────────────────────────────────────────────────────────
  step("Expense controls");
  const ex = await fc.controlsReport(org, "expenses", ...P);
  const e = side(ex as any);
  check("awaiting approval: the AED expense", ln(e, "approval:waiting")?.amountMinor === 1_000_00);
  check("paid with no document (EXP-NODOC) and no reference", ex.rows.some((r) => r.line === "no_attachment" && r.number === "EXP-NODOC") && ex.rows.some((r) => r.line === "no_reference"));
  check("late-recorded (entered 40 days after its date) and entered after its month", ex.rows.some((r) => r.line === "late" && r.number === "EXP-NODOC") && ex.rows.some((r) => r.line === "outside_period" && r.number === "EXP-NODOC"));
  check("unusual movement: marketing 20,000 against 4,000 average (+400%)", ex.rows.some((r) => r.section === "movements" && r.line === "up" && r.amountMinor === 16_000_00), j(ex.rows.filter((r) => r.section === "movements").map((r) => [r.month, r.amountMinor])));
  check("possible duplicate from Phase 5 (EXP-DUP)", ln(e, "integrity:duplicate")?.count === 1);

  // ── Payroll ────────────────────────────────────────────────────────────────
  step("Payroll and commission controls");
  const pr = await fc.controlsReport(org, "payroll", ...P);
  const p = side(pr as any);
  check("run waiting for approval (6,000); part-paid run with 2,000 outstanding; 1 person on hold", ln(p, "runs:awaiting")?.amountMinor === 6_000_00 && ln(p, "runs:part_paid")?.amountMinor === 2_000_00 && ln(p, "hold:on_hold")?.count === 1, j(p.sections));
  check("payroll reversal (300) from Phase 5", ln(p, "reversals:reversed")?.amountMinor === -300_00);
  check("commission outstanding 1,500; paid twice 700 flagged critical; typed commission naming the payee to verify", ln(p, "commission:outstanding")?.amountMinor === 1_500_00 && ln(p, "commission:paid_twice")?.amountMinor === 700_00 && ln(p, "commission:verify_named")?.amountMinor === 500_00);

  // ── VAT ────────────────────────────────────────────────────────────────────
  step("VAT and compliance");
  const vt = await fc.controlsReport(org, "vat", ...P);
  const v = side(vt as any);
  check("input VAT from finance's VAT report (both bills: 100 + 150); net labelled indicative, not a confirmed liability", ln(v, "vat:input")?.amountMinor === 250_00 && /not a confirmed liability/.test(v.totals.find((t) => t.key === "net")?.label ?? ""), j(v));
  check("taxed bills from a vendor with no VAT number flagged (both)", ln(v, "gaps:vendor_vat")?.count === 2);
  check("documentation gaps carried", (ln(v, "docs:no_attachment")?.count ?? 0) >= 1);

  // ── Closing ────────────────────────────────────────────────────────────────
  step("Monthly closing readiness");
  const cl = await fc.controlsReport(org, "closing", ...P);
  const st = (mo: string, key: string) => cl.rows.find((r) => r.section === mo && r.line === key)?.status;
  check("previous month: bank Incomplete (no reconciliation), payroll Incomplete (part paid), suppliers Requires review (overdue bill)", st(prev, "bank") === "Incomplete" && st(prev, "payroll") === "Incomplete" && st(prev, "suppliers") === "Requires review", j(cl.rows.filter((r) => r.section === prev).map((r) => [r.line, r.status])));
  check("advances Unable to verify; VAT Requires review; historical Unable to verify — never shown as complete", st(prev, "advances") === "Unable to verify" && st(prev, "vat") === "Requires review" && st(prev, "historical") === "Unable to verify");
  check("exceptions: critical overpaid invoice dated last month → Requires review", st(prev, "exceptions") === "Requires review");
  check("this month: payroll Incomplete (run imported, not paid); expenses Incomplete (one waiting)", st(thisMonth, "payroll") === "Incomplete" && st(thisMonth, "expenses") === "Incomplete", j([st(thisMonth, "payroll"), st(thisMonth, "expenses")]));
  check("every month says it is not closed", cl.sides[0]!.sections.every((s) => /not closed/.test(s.title)));
  void prevEnd;

  // ── Audit ──────────────────────────────────────────────────────────────────
  step("Audit and activity");
  const au = await fc.controlsReport(org, "audit", ...P);
  check("payroll payment deleted: by whom and why", au.rows.some((r) => r.line === "deleted" && /Payroll Officer/.test(r.detail) && /duplicate entry/.test(r.detail)));
  check("payroll reversal: when and why; who reversed it 'not recorded'", au.rows.some((r) => r.line === "reversed" && /not recorded/.test(r.detail)));
  check("invoice void: who and when 'not recorded' (never invented)", au.rows.some((r) => r.line === "void" && r.account === "Not recorded"));
  check("late entry: who entered it", au.rows.some((r) => r.section === "late" && /Clerk/.test(r.detail)));
  check("records created/changed are counts with 'what and who not recorded'", au.rows.some((r) => r.section === "modified" && /not recorded/.test(r.detail)));

  // ── Overview ───────────────────────────────────────────────────────────────
  step("Dashboard = reports");
  const ov = await fc.controlsReport(org, "overview", ...P);
  const ind = (key: string, c = "AED") => ov.indicators.find((x) => x.key === key && x.currency === c)?.value;
  check("pending approvals and amount = FC-02", ind("pending") === pending.filter((r) => r.currency === "AED").length && ind("pending_amount") === sec(a, "pending"), j([ind("pending"), ind("pending_amount"), sec(a, "pending")]));
  check("overdue approvals = FC-02 overdue", ind("overdue") === pending.filter((r) => r.currency === "AED" && (r.ageDays ?? 0) > 3).length);
  check("critical/high = RC-08", ind("critical") === exc.rows.filter((r) => r.currency === "AED" && r.severity === "critical").length && ind("high") === exc.rows.filter((r) => r.currency === "AED" && r.severity === "high").length);
  const rcSum = await rc.reconciliationReport(org, "summary", ...P);
  check("unreconciled accounts = Phase 5", ind("unreconciled") === rcSum.indicators.find((x) => x.key === "unreconciled" && x.currency === "AED")?.value);
  check("outstanding obligations = Phase 4", ind("obligations") === tot(obl, "total"));
  const oblLine = (k: string) => obl.sections.flatMap((x) => x.lines).find((x) => x.key === `obl:${k}`)?.amountMinor ?? 0;
  check("unpaid salaries and commission = FC-06's 'unpaid as of the date' = Phase 4's salaries + commission", ind("salaries_commission") === tot(p, "owed") && tot(p, "owed") === oblLine("salaries") + oblLine("commission"), j([ind("salaries_commission"), tot(p, "owed"), oblLine("salaries"), oblLine("commission")]));
  check("closing readiness figure present with 'no period is closed'", ov.indicators.some((x) => x.key === "closing" && /no period is closed/i.test(x.note ?? "")));
  check("INR indicators on their own", ind("pending", "INR") === 1);

  step("Drill-downs and Root's feed");
  check("records add up: approvals 'pending' = its records", fc.fcLinesOf(ap.rows, "pending").filter((r) => r.currency === "AED").reduce((n, r) => n + r.amountMinor, 0) === sec(a, "pending"));
  const root = await portal.controlsForPortal({ org, from: P[0], to: P[1], report: "overview" }) as any;
  check("Root gets the indicators, without records", typeof root === "object" && !("rows" in root) && root.indicators.length >= 11);
  const rl = await portal.controlsLinesForPortal({ org, from: P[0], to: P[1], report: "approvals", line: "pending", stage: "Overdue" }) as any;
  check("Root filters records (overdue approvals)", typeof rl === "object" && rl.totals.count === pending.filter((r) => r.currency === "AED" && r.kind === "Overdue").length, j(rl.totals));
  check("a wrong report is refused", typeof (await portal.controlsForPortal({ org, from: P[0], to: P[1], report: "nope" })) === "string");

  step("Nothing written");
  check("records unchanged", (await Expense.collection.countDocuments({ organizationId: O, status: "submitted" })) === 2 && (await PayrollRun.collection.findOne({ runNumber: "PAY-NOW" }))!.status === "imported" && (await LateEntryModel.collection.findOne({}))!.state === "pending");
} catch (err) {
  failures++;
  console.error(err);
} finally {
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? `, ${failures} failed` : ""}`);
process.exit(failures ? 1 : 0);
