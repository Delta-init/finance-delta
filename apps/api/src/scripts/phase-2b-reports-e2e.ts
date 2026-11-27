/**
 * Phase 2B report corrections (2026-11-27), against a scratch database through the real report services:
 *
 *   F03  credit notes come off invoiced income in the P&L (issued / applied, by the day issued, before VAT), never
 *        voided ones, drafts, ones from another period or on a void invoice; another currency's apart; the popups add
 *        up to the lines; the collected view (payments only) is untouched.
 *   F13  Expense by Category totals what the invoiced P&L's expenses total: a bill once, before VAT, under its own
 *        category (its VAT-inclusive mirror expense not on top); payroll in the month the pay is for.
 *   F14  vendor credits come off supplier cost (before VAT) and their VAT off input VAT — finance's VAT report and
 *        Root's input VAT list — never voided ones or drafts; another currency's apart.
 *
 * Run through scripts/phase-2b-reports-e2e.sh. Scratch database only.
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
const { syncBillExpense } = await import("../modules/bill/bill-expense");
const reports = await import("../modules/reports/reports.service");
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
const lineOf = (b: { key?: string; amountMinor: number }[], key: string) => b.find((x) => x.key === key)?.amountMinor;

await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const now = new Date();
const d = (s: string) => new Date(`${s}T10:00:00Z`);
const O = (await Organization.collection.insertOne({ name: "Test Org", slug: `t-${Date.now()}`, baseCurrency: "AED", currency: "AED", createdAt: now, updatedAt: now })).insertedId;
const org = String(O);
const customerId = new Types.ObjectId();
const vendorId = new Types.ObjectId();
const FROM = "2026-11-01", TO = "2026-11-30";

const invoice = async (n: string, subtotal: number, tax: number, opts: { currency?: string; status?: string; paid?: number; day?: string } = {}) => {
  const total = subtotal + tax, paid = opts.paid ?? 0;
  const payments = paid ? [{ _id: new Types.ObjectId(), method: "cash", amountMinor: paid, paidOn: d("2026-11-10"), reference: "" }] : [];
  const r = await Invoice.collection.insertOne({
    organizationId: O, invoiceNumber: n, customerId, customerName: "Client", salespersonName: "Sales", status: opts.status ?? (paid ? "partial" : "sent"),
    currency: opts.currency ?? "AED", issueDate: d(opts.day ?? "2026-11-05"), dueDate: d("2026-12-05"), lineItems: [],
    subtotalMinor: subtotal, taxTotalMinor: tax, totalMinor: total, amountPaidMinor: paid, balanceMinor: total - paid, payments,
    exchangeRate: 1, baseTotalMinor: total, createdAt: now, updatedAt: now,
  });
  return { id: r.insertedId, n };
};
const creditNote = async (inv: { id: unknown; n: string }, subtotal: number, tax: number, status: string, opts: { currency?: string; day?: string } = {}) =>
  CreditNote.collection.insertOne({
    organizationId: O, creditNoteNumber: `CN-${Math.random().toString(36).slice(2, 8)}`, invoiceId: inv.id, invoiceNumber: inv.n, customerId, customerName: "Client",
    reason: "Discount", status, lineItems: [], subtotalMinor: subtotal, taxTotalMinor: tax, totalMinor: subtotal + tax,
    amountAppliedMinor: status === "applied" ? subtotal + tax : 0, currency: opts.currency ?? "AED",
    ...(status === "draft" ? {} : { issuedAt: d(opts.day ?? "2026-11-15") }), createdAt: now, updatedAt: now,
  });
const bill = async (n: string, subtotal: number, taxPct: number, opts: { currency?: string; status?: string; category?: string; subcategory?: string } = {}) => {
  const tax = Math.round((subtotal * taxPct) / 100);
  const r = await Bill.collection.insertOne({
    organizationId: O, billNumber: n, vendorId, vendorName: "Supplier", billDate: d("2026-11-08"), dueDate: d("2026-12-08"), status: opts.status ?? "approved",
    currency: opts.currency ?? "AED", lineItems: [{ description: "Goods", quantity: 1, unitPriceMinor: subtotal, discountPct: 0, taxPct, lineTotalMinor: subtotal + tax }],
    subtotalMinor: subtotal, taxTotalMinor: tax, totalMinor: subtotal + tax, amountPaidMinor: 0, balanceMinor: subtotal + tax, payments: [],
    category: opts.category ?? null, subcategory: opts.subcategory ?? null, createdAt: now, updatedAt: now,
  });
  await syncBillExpense(org, r.insertedId);
  return r.insertedId;
};
const vendorCredit = async (subtotal: number, taxPct: number, status: string, opts: { currency?: string; day?: string } = {}) => {
  const tax = Math.round((subtotal * taxPct) / 100);
  return VendorCredit.collection.insertOne({
    organizationId: O, creditNumber: `VC-${Math.random().toString(36).slice(2, 8)}`, vendorId, vendorName: "Supplier", sourceBillNumber: "BILL-1", reason: "Returned goods",
    issueDate: d(opts.day ?? "2026-11-20"), status, currency: opts.currency ?? "AED",
    lineItems: [{ description: "Returned", quantity: 1, unitPriceMinor: subtotal, discountPct: 0, taxPct, lineTotalMinor: subtotal + tax }],
    subtotalMinor: subtotal, taxTotalMinor: tax, totalMinor: subtotal + tax, amountAppliedMinor: 0, createdAt: now, updatedAt: now,
  });
};

try {
  // ── F03 ──────────────────────────────────────────────────────────────────
  step("F03 — credit notes in the P&L");
  const i1 = await invoice("INV-1", 100_000, 5_000, { paid: 30_000 });
  const i2 = await invoice("INV-2", 50_000, 2_500);
  const iVoid = await invoice("INV-VOID", 30_000, 0, { status: "void" });
  const iInr = await invoice("INV-INR", 200_000, 0, { currency: "INR" });
  await creditNote(i1, 10_000, 500, "issued");                 // counts: 100
  await creditNote(i2, 5_000, 250, "applied");                 // counts: 50
  await creditNote(i1, 7_000, 0, "voided");                    // never
  await creditNote(i1, 3_000, 0, "draft");                     // never
  await creditNote(iVoid, 4_000, 0, "issued");                 // its invoice is void: never
  await creditNote(i2, 2_000, 0, "issued", { day: "2026-10-20" }); // another period
  await creditNote(iInr, 20_000, 0, "issued", { currency: "INR" }); // apart

  const pl = await reports.getProfitLoss(org, FROM, TO);
  check("invoice revenue 1,500 (void invoice and rupees out)", lineOf(pl.income.breakdown, "invoices") === 150_000, j(pl.income));
  check("less credit notes −150: issued 100 + applied 50, before VAT", lineOf(pl.income.breakdown, "credit-notes") === -15_000, j(pl.income));
  check("total income 1,350", pl.income.total === 135_000, j(pl.income.total));
  const inr = (pl.income.otherCurrencies ?? []).filter((l) => l.currency === "INR");
  check("rupees apart: invoices 2,000 and their credit note −200, never in AED",
    inr.some((l) => l.what === "Invoice revenue" && l.amountMinor === 200_000) && inr.some((l) => l.what === "Less credit notes" && l.amountMinor === -20_000), j(pl.income.otherCurrencies));
  const linesIncome = await reports.profitLossLines(org, FROM, TO, "invoiced", "income");
  const linesInv = await reports.profitLossLines(org, FROM, TO, "invoiced", "invoices");
  const linesCn = await reports.profitLossLines(org, FROM, TO, "invoiced", "credit-notes");
  check("popup: total income's records add up to 1,350 (2 invoices, 2 credit notes)", linesIncome.totalMinor === pl.income.total && linesIncome.rows.length === 4, j(linesIncome.rows.map((r) => [r.number, r.amountMinor])));
  check("popup: invoice revenue's records add up to its line", linesInv.totalMinor === 150_000 && linesInv.rows.every((r) => r.kind === "invoice"));
  check("popup: credit notes' records add up to −150, each a credit note", linesCn.totalMinor === -15_000 && linesCn.rows.length === 2 && linesCn.rows.every((r) => r.kind === "credit note" && r.amountMinor < 0), j(linesCn.rows));
  const cash = await reports.getProfitLoss(org, FROM, TO, "AED", "collected");
  check("collected view untouched: payments received 300, no credit note anywhere", cash.income.total === 30_000 && !cash.income.breakdown.some((l) => l.key === "credit-notes"), j(cash.income));
  check("strip: invoiced 1,350, collected 300", pl.bases?.invoicedMinor === 135_000 && pl.bases?.collectedMinor === 30_000, j(pl.bases));
  const cashCn = await reports.profitLossLines(org, FROM, TO, "collected", "credit-notes");
  check("collected popup for credit notes: none", cashCn.rows.length === 0);

  // ── F14 + F13 ────────────────────────────────────────────────────────────
  step("F14 — vendor credits; F13 — Expense by Category");
  await bill("BILL-1", 100_000, 5);                                          // 1,000 + VAT 50, unfiled
  await bill("BILL-INR", 800_000, 0, { currency: "INR" });                   // apart
  await bill("BILL-DRAFT", 9_000, 5, { status: "draft" });                   // never
  await vendorCredit(20_000, 5, "issued");                                   // −200, VAT −10
  await vendorCredit(10_000, 5, "voided");                                   // never
  await vendorCredit(5_000, 5, "draft");                                     // never
  await vendorCredit(6_000, 5, "applied", { day: "2026-10-15" });            // another period
  await vendorCredit(50_000, 0, "issued", { currency: "INR" });              // apart
  await Expense.collection.insertOne({ organizationId: O, expenseNumber: "EXP-TYPED", category: "office_supplies", subcategory: null, description: "Pens",
    expenseDate: d("2026-11-12"), paidOn: d("2026-11-12"), amountMinor: 30_000, taxMinor: 0, totalMinor: 30_000, currency: "AED", status: "approved", createdAt: now, updatedAt: now });
  const runNov = (await PayrollRun.collection.insertOne({ organizationId: O, runNumber: "PR-NOV", period: "2026-11", status: "paid", lines: [], adjustments: [], createdAt: now, updatedAt: now })).insertedId;
  await Expense.collection.insertOne({ organizationId: O, expenseNumber: "EXP-PAY", category: "salaries", subcategory: null, description: "November salaries",
    expenseDate: d("2026-12-02"), paidOn: d("2026-12-02"), amountMinor: 40_000, taxMinor: 0, totalMinor: 40_000, currency: "AED", status: "approved",
    source: { kind: "payroll", key: `payroll:${runNov}:p1` }, createdAt: now, updatedAt: now });

  const pl2 = await reports.getProfitLoss(org, FROM, TO);
  check("supplier bills 1,000 before VAT (draft and rupee bills out)", lineOf(pl2.expenses.breakdown, "bills") === 100_000, j(pl2.expenses.breakdown));
  check("less vendor credits −200, before VAT", lineOf(pl2.expenses.breakdown, "vendor-credits") === -20_000, j(pl2.expenses.breakdown));
  check("total expenses 1,000 − 200 + 300 typed + 400 November payroll = 1,500", pl2.expenses.total === 150_000, j(pl2.expenses));
  check("net profit 1,350 − 1,500 = −150", pl2.netProfitMinor === -15_000, j(pl2.netProfitMinor));
  const inrCosts = (pl2.expenses.otherCurrencies ?? []).find((c) => c.currency === "INR");
  check("rupee bill 8,000 and its credit −500 apart: 7,500", inrCosts?.amountMinor === 750_000 && lineOf(inrCosts.breakdown, "vendor-credits") === -50_000, j(inrCosts));
  const vcLines = await reports.profitLossLines(org, FROM, TO, "invoiced", "vendor-credits");
  const expLines = await reports.profitLossLines(org, FROM, TO, "invoiced", "expenses");
  check("popup: vendor credits add up to −200", vcLines.totalMinor === -20_000 && vcLines.rows.length === 1 && vcLines.rows[0]!.kind === "vendor credit", j(vcLines.rows));
  check("popup: total expenses' records add up to 1,500", expLines.totalMinor === pl2.expenses.total, j(expLines.rows.map((r) => [r.number, r.amountMinor])));
  const cash2 = await reports.getProfitLoss(org, FROM, TO, "AED", "collected");
  check("collected view: no vendor credit (no money moved), no bill paid; pens 300 + November payroll 400 (paid) = 700", !cash2.expenses.breakdown.some((l) => l.key === "vendor-credits") && cash2.expenses.total === 70_000, j(cash2.expenses));

  const cats = await reports.getExpenseByCategory(org, FROM, TO);
  check("Expense by Category total = the P&L's expenses, 1,500", cats.grandTotalMinor === pl2.expenses.total, j(cats));
  const billRow = cats.categories.find((c) => c.category.startsWith("Other"));
  check("the bill once, under its own category, 1,000 before VAT (not 1,050, not twice)", billRow?.totalMinor === 100_000 && billRow.count === 1, j(cats.categories));
  check("vendor credits a line of their own, −200", cats.categories.find((c) => c.category === "Less vendor credits")?.totalMinor === -20_000, j(cats.categories));
  check("November payroll paid in December counted in November", cats.categories.some((c) => c.totalMinor === 40_000), j(cats.categories));
  const catsDec = await reports.getExpenseByCategory(org, "2026-12-01", "2026-12-31");
  check("December: the November payroll is not there again", catsDec.grandTotalMinor === 0, j(catsDec));
  const plDec = await reports.getProfitLoss(org, "2026-12-01", "2026-12-31");
  check("December P&L agrees: 0", plDec.expenses.total === 0, j(plDec.expenses));
  check("rupees apart in Expense by Category", (cats.otherCurrencies ?? []).some((l) => l.currency === "INR" && l.what === "Supplier bills" && l.amountMinor === 800_000), j(cats.otherCurrencies));
  const payroll = await Expense.collection.findOne({ expenseNumber: "EXP-PAY" });
  check("the payroll expense keeps its own dates", +new Date(payroll!.expenseDate) === +d("2026-12-02") && +new Date(payroll!.paidOn) === +d("2026-12-02"));

  const vat = await reports.getVATReport(org, FROM, TO);
  // Input VAT counts every currency's bills as before (an existing limitation, not changed here): AED 50 − 10 = 40.
  check("input VAT: bill 50 less the vendor credit's 10 = 40 (voided/draft/other period out)", vat.inputTaxMinor === 4_000, j(vat));
  check("input VAT at 5%: 40", vat.byRate.find((r) => r.code === "Input 5%")?.inputMinor === 4_000, j(vat.byRate));
  const root = await portal.vatReportForPortal({ org, from: FROM, to: TO, kind: "input" }) as any;
  check("Root input VAT list: the bill and the vendor credit, AED total 40", typeof root === "object" && root.totals?.amountMinor === 4_000 && root.totals?.count === 2, j(root?.totals));
  const rootLines = await portal.plLinesForPortal({ org, from: FROM, to: TO, line: "credit-notes" }) as any;
  check("Root accepts the new popup lines (credit notes −150)", typeof rootLines === "object" && rootLines.totals?.amountMinor === -15_000, j(rootLines?.totals ?? rootLines));
  const rootVc = await portal.plLinesForPortal({ org, from: FROM, to: TO, line: "vendor-credits" }) as any;
  check("Root: vendor credits popup −200", typeof rootVc === "object" && rootVc.totals?.amountMinor === -20_000, j(rootVc?.totals ?? rootVc));
} catch (e) {
  failures++;
  console.error(e);
} finally {
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} passed${failures ? `, ${failures} failed` : ""}`);
process.exit(failures ? 1 : 0);
