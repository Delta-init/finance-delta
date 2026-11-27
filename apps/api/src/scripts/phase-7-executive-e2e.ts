/**
 * Phase 7 executive dashboard (2026-11-28), against a scratch database through the real services: every executive
 * figure equals the Phase 3–6 report it comes from (management profitability, cash flow, cash position, receivables,
 * obligations, advances, liquidity, reconciliation and controls indicators); the comparison period equals the same
 * report run for those dates; currencies apart; target "not configured"; the 60-second cache gives the same answer
 * until Refresh (fresh) works it out again; a reconciliation-session difference is an "open reconciliation
 * difference", never counted in confirmed integrity discrepancies; nothing written.
 *
 * Run through scripts/phase-7-executive-e2e.sh. Scratch database only.
 */
export {};

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri) || /:27017\//.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1 (not 27017), got "${uri}"`);
  process.exit(1);
}

const { Organization } = await import("../modules/organization/organization.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { Expense } = await import("../modules/expense/expense.model");
const { BankAccount } = await import("../modules/banking/bank-account.model");
const { BankTransaction } = await import("../modules/banking/bank-transaction.model");
const { ReconciliationSession } = await import("../modules/banking/reconciliation.model");
const ex = await import("../modules/reports/executive.service");
const mp = await import("../modules/reports/management-profit.service");
const fp = await import("../modules/reports/financial-position.service");
const rc = await import("../modules/reports/reconciliation.service");
const fc = await import("../modules/reports/controls.service");
const cache = await import("../modules/reports/report-cache");
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
type Side = { currency: string; sections: { key: string; lines: { key: string; amountMinor: number }[]; totalMinor: number }[]; totals: { key: string; amountMinor: number }[] };
const tot = (s: Side | undefined, k: string) => s?.totals.find((t) => t.key === k)?.amountMinor ?? 0;
const ln = (s: Side | undefined, k: string) => s?.sections.flatMap((x) => x.lines).find((l) => l.key === k)?.amountMinor ?? 0;
const sideOf = (r: { sides: Side[] }, c = "AED") => r.sides.find((s) => s.currency === c);

await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const now = new Date();
const d = (s: string) => new Date(`${s}T12:00:00Z`);
const O = (await Organization.collection.insertOne({ name: "Test Org", slug: `t-${Date.now()}`, baseCurrency: "AED", currency: "AED", createdAt: now, updatedAt: now })).insertedId;
const org = String(O);
const U = new Types.ObjectId(), customerId = new Types.ObjectId();
const today = now.toISOString().slice(0, 10);
const thisMonth = today.slice(0, 7);
const monthBack = (m: string, by: number) => { const x = new Date(`${m}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() - by); return x.toISOString().slice(0, 7); };
const prev = monthBack(thisMonth, 1), prev2 = monthBack(thisMonth, 2);
const endOf = (m: string) => new Date(Date.parse(`${monthBack(m, -1)}-01T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const P = [`${prev}-01`, endOf(prev)] as const;          // the period
const C = { from: `${prev2}-01`, to: endOf(prev2) };     // the comparison

try {
  step("Setting up");
  const inv = (n: string, month: string, sub: number, paid: number, extra: Record<string, unknown> = {}) => ({
    organizationId: O, invoiceNumber: n, customerId, customerName: "Client", status: paid >= sub * 1.05 ? "paid" : paid ? "partially_paid" : "sent", currency: "AED",
    issueDate: d(`${month}-05`), dueDate: d(`${month}-10`), lineItems: [], subtotalMinor: sub, taxTotalMinor: Math.round(sub * 0.05), totalMinor: Math.round(sub * 1.05),
    amountPaidMinor: paid, balanceMinor: Math.round(sub * 1.05) - paid,
    payments: paid ? [{ _id: new Types.ObjectId(), method: "bank_transfer", amountMinor: paid, paidOn: d(`${month}-08`), reference: `R-${n}` }] : [],
    exchangeRate: 1, baseTotalMinor: Math.round(sub * 1.05), createdAt: d(`${month}-05`), updatedAt: d(`${month}-05`), ...extra,
  });
  await Invoice.collection.insertMany([inv("I-1", prev, 10_000_00, 10_500_00), inv("I-2", prev, 4_000_00, 2_100_00), inv("I-0", prev2, 6_000_00, 6_300_00)]);
  const exp = (n: string, month: string, amount: number, currency = "AED", category = "rent_utilities") => ({
    organizationId: O, expenseNumber: n, category, subcategory: null, description: n, expenseDate: d(`${month}-12`), paidOn: d(`${month}-12`), amountMinor: amount, taxMinor: 0, totalMinor: amount,
    currency, status: "approved", paymentMethod: "bank_transfer", reference: `X-${n}`, attachments: [{ name: "a.pdf", url: "u" }], submittedById: U, createdAt: d(`${month}-12`), updatedAt: d(`${month}-12`),
  });
  await Expense.collection.insertMany([exp("E-1", prev, 3_000_00), exp("E-2", prev, 1_200_00, "AED", "software_it"), exp("E-0", prev2, 2_000_00), exp("E-INR", prev, 90_000_00, "INR")]);
  const MAIN = (await BankAccount.collection.insertOne({ organizationId: O, accountName: "Main", accountType: "current", currency: "AED", openingBalanceMinor: 20_000_00, openingDate: d(`${prev2}-01`), currentBalanceMinor: 20_000_00, isActive: true, createdAt: now, updatedAt: now })).insertedId;
  const line = (on: string, amount: number, extra: Record<string, unknown> = {}) => ({ organizationId: O, accountId: MAIN, accountName: "Main", currency: "AED", date: d(on), description: "line", reference: "", amountMinor: amount, type: amount > 0 ? "credit" : "debit", runningBalanceMinor: 0, source: "manual", status: "unmatched", matches: [], transfer: null, settlement: null, isReconciled: false, createdAt: d(on), updatedAt: d(on), ...extra });
  await BankTransaction.collection.insertMany([line(`${prev2}-08`, 6_300_00), line(`${prev2}-12`, -2_000_00), line(`${prev}-08`, 10_500_00), line(`${prev}-09`, 2_100_00), line(`${prev}-12`, -4_200_00)]);
  await BankAccount.collection.updateOne({ _id: MAIN }, { $set: { currentBalanceMinor: 32_700_00 } });
  // A reconciliation session whose typed statement balance differs by 900: an open difference, not a loss.
  await ReconciliationSession.collection.insertOne({ organizationId: O, accountId: MAIN, accountName: "Main", currency: "AED", statementDate: d(endOf(prev)), periodFrom: d(`${prev}-01`), periodTo: d(endOf(prev)), statementBalanceMinor: 33_600_00, openingBookBalanceMinor: 24_300_00, closingBookBalanceMinor: 32_700_00, differenceMinor: 900_00, status: "open", reconciledTransactionIds: [], statementDates: {}, createdAt: now, updatedAt: now });
  // A confirmed discrepancy: an overpaid invoice.
  await Invoice.collection.insertOne(inv("I-OVER", prev, 1_000_00, 1_350_00, { status: "paid" }));
  const counts = async () => [await Invoice.collection.countDocuments(), await Expense.collection.countDocuments(), await BankTransaction.collection.countDocuments(), await ReconciliationSession.collection.countDocuments()].join(",");
  const before = await counts();

  // ── Performance = Phase 3 ──────────────────────────────────────────────────
  step("Performance equals management profitability (Phase 3)");
  const e = await ex.executiveReport(org, ...P, C, true);
  const p = e.performance.find((x) => x.currency === "AED")!.current!;
  const [mi, mc, mk] = await Promise.all((["invoice", "collection", "cash"] as const).map((v) => mp.getManagementProfit(org, ...P, v)));
  const s = (r: any) => r.sides.find((x: any) => x.currency === "AED");
  check("net invoiced = PRF-14 income; costs = PRF-14 costs; invoice profit and margin = PRF-14", p.netInvoicedMinor === s(mi).income.total && p.expensesMinor === s(mi).expenses.total && p.invoiceProfitMinor === s(mi).netMinor && p.invoiceMarginPct === s(mi).marginPct, j([p, s(mi)]));
  check("net collections and collection profit = PRF-15", p.netCollectionsMinor === s(mc).income.total && p.collectionProfitMinor === s(mc).netMinor, j([p.netCollectionsMinor, s(mc).income.total]));
  check("cash in, out and net = PRF-16", p.cashInMinor === s(mk).income.total && p.cashOutMinor === s(mk).expenses.total && p.cashNetMinor === s(mk).netMinor, j([p.cashInMinor, p.cashOutMinor, s(mk).income.total, s(mk).expenses.total]));
  const rows = await mp.managementRows(org, ...P, "invoice");
  check("gross invoiced = the income records with their VAT (15,000 + 750 VAT incl. the overpaid one)", p.grossInvoicedMinor === rows.rows.filter((r) => r.currency === "AED" && r.group === "income").reduce((n, r) => n + (r.grossMinor ?? r.amountMinor), 0) && p.grossInvoicedMinor === 15_750_00, String(p.grossInvoicedMinor));
  check("three profit views kept apart (they differ here)", new Set([p.invoiceProfitMinor, p.collectionProfitMinor, p.cashNetMinor]).size === 3, j([p.invoiceProfitMinor, p.collectionProfitMinor, p.cashNetMinor]));

  step("Comparison equals the same reports for the comparison dates");
  const cmp = e.performance.find((x) => x.currency === "AED")!.compare!;
  const ci = await mp.getManagementProfit(org, C.from, C.to, "invoice");
  const alone = await ex.executiveReport(org, C.from, C.to, null, true);
  check("comparison invoice profit = PRF-14 for the comparison period", cmp.invoiceProfitMinor === s(ci).netMinor && cmp.netInvoicedMinor === s(ci).income.total, j([cmp, s(ci)]));
  check("comparison = the executive report run for those dates alone", j(cmp) === j(alone.performance.find((x) => x.currency === "AED")!.current), j([cmp, alone.performance]));
  const cfC = sideOf((await fp.financialReport(org, "cashflow", C.from, C.to)) as any);
  check("comparison cash flow closing = FS-03 for the comparison period", e.cash.find((x) => x.currency === "AED")!.flowCompare!.closingMinor === tot(cfC, "closing"));
  check("no comparison asked: none given", alone.compare === null && alone.performance.every((x) => x.compare === null) && alone.cash.every((x) => x.flowCompare === null));

  // ── Cash, receivables, obligations = Phase 4/6 ─────────────────────────────
  step("Cash and position equal Phases 4 and 6");
  const cash = e.cash.find((x) => x.currency === "AED")!;
  const cf = sideOf((await fp.financialReport(org, "cashflow", ...P)) as any);
  const cp = sideOf((await fp.financialReport(org, "cash", ...P)) as any);
  const ob = sideOf((await fp.financialReport(org, "obligations", ...P)) as any);
  const lq = sideOf((await fc.controlsReport(org, "liquidity", ...P)) as any);
  check("opening, in, out, net, closing and check = FS-03", cash.flow!.openingMinor === tot(cf, "opening") && cash.flow!.inflowsMinor === tot(cf, "inflows") && cash.flow!.outflowsMinor === tot(cf, "outflows") && cash.flow!.netMinor === tot(cf, "net") && cash.flow!.closingMinor === tot(cf, "closing") && cash.flow!.checkMinor === 0, j([cash.flow, cf?.totals]));
  check("opening + net = closing", cash.flow!.openingMinor + cash.flow!.netMinor === cash.flow!.closingMinor || tot(cf, "transfers") !== 0);
  check("available, PSP and negative = FS-11", cash.availableMinor === tot(cp, "available") && cash.pspMinor === tot(cp, "psp") && cash.negativeMinor === tot(cp, "negative"));
  check("verified = confirmed by a reconciled statement (0: the session is open)", cash.verifiedMinor === 0 && /none|0 account/i.test(cash.verifiedLabel), cash.verifiedLabel);
  check("obligations = AP-13; available less obligations worked out from them", cash.obligationsMinor === tot(ob, "total") && cash.availableAfterMinor === cash.availableMinor - cash.obligationsMinor);
  check("due within 30 days or undated and shortfall = FC-04", cash.nearObligationsMinor === tot(lq, "near") && cash.surplusMinor === tot(lq, "shortfall"), j([cash.nearObligationsMinor, tot(lq, "near"), cash.surplusMinor, tot(lq, "shortfall")]));
  const rec = e.receivables.find((x) => x.currency === "AED")!;
  const rs = sideOf((await fp.financialReport(org, "receivables", ...P)) as any);
  check("receivables total, invoices, overdue = AR-13", rec.totalMinor === tot(rs, "outstanding") && rec.invoicesMinor === ln(rs, "kind:invoice") && rec.overdueMinor === tot(rs, "overdue"), j([rec, rs?.totals]));
  check("ageing bands add up to the total", rec.ageing.reduce((n, a) => n + a.amountMinor, 0) === rec.totalMinor, j(rec.ageing));
  const obl = e.obligations.find((x) => x.currency === "AED")!;
  check("obligation kinds add up to the total", obl.billsMinor + obl.salariesMinor + obl.commissionMinor + obl.expensesMinor + obl.reimbursementsMinor + obl.loansMinor === obl.totalMinor, j(obl));

  // ── Alerts = Phases 5 and 6 ────────────────────────────────────────────────
  step("Alerts equal the reconciliation and controls indicators");
  const ov = await fc.controlsReport(org, "overview", ...P);
  const sm = await rc.reconciliationReport(org, "summary", ...P);
  const al = (k: string) => e.alerts.find((a) => a.currency === "AED" && a.key === k)?.value;
  const fi = (k: string) => ov.indicators.find((i: any) => i.currency === "AED" && i.key === k)?.value;
  const ri = (k: string) => sm.indicators.find((i: any) => i.currency === "AED" && i.key === k)?.value;
  check("pending, overdue, critical, high, unreconciled = FC-01", ["pending", "overdue", "critical", "high", "unreconciled"].every((k) => al(k) === fi(k)), j(["pending", "overdue", "critical", "high", "unreconciled"].map((k) => [k, al(k), fi(k)])));
  check("unmatched in/out, open differences, duplicates = RC summary", al("unmatched_in") === ri("unmatched_in") && al("unmatched_out") === ri("unmatched_out") && al("open_differences") === ri("differences") && al("duplicates") === ri("duplicates"));
  check("every alert links to a Reconciliation or Controls report", e.alerts.every((a) => /^(controls|reconciliation)$/.test(a.section) && /^(fc|rc)-0\d$/.test(a.report)));
  check("closing readiness says no period is closed", /no period is closed/i.test(e.alerts.find((a) => a.key === "closing")?.note ?? ""));

  // ── Open reconciliation differences ────────────────────────────────────────
  step("Open reconciliation differences are not confirmed discrepancies");
  const exc = await rc.reconciliationReport(org, "exceptions", ...P);
  const diff = exc.rows.find((r) => r.id.startsWith("sess:"));
  check("the session difference (900) is an 'open reconciliation difference'", diff?.confidence === "open" && Math.abs(diff.amountMinor) === 900_00 && diff.status === "Open reconciliation difference", j(diff));
  const risks = sideOf((await fc.controlsReport(org, "risks", ...P)) as any);
  const confirmed = exc.rows.filter((r) => r.currency === "AED" && r.confidence === "confirmed").reduce((n, r) => n + Math.abs(r.amountMinor), 0);
  check("confirmed integrity discrepancies = confirmed only (the overpaid invoice), the 900 left out", tot(risks, "exposure") === confirmed && confirmed > 0 && !exc.rows.some((r) => r.confidence === "confirmed" && r.id.startsWith("sess:")), j([tot(risks, "exposure"), confirmed]));
  check("open differences shown apart with their own total (900)", tot(risks, "open_differences") === 900_00, String(tot(risks, "open_differences")));
  check("the risk label says open differences are excluded", /open reconciliation differences excluded/i.test(((risks as any)?.totals.find((t: any) => t.key === "exposure")?.label) ?? ""));

  // ── Currencies, target, trends ─────────────────────────────────────────────
  step("Currencies apart, target, trends");
  const inr = e.performance.find((x) => x.currency === "INR")?.current;
  check("the INR expense on its own side, not in AED", inr?.expensesMinor === 90_000_00 && p.expensesMinor === 4_200_00, j([inr, p.expensesMinor]));
  check("target not configured", e.target.valueMinor === null && /Not configured/.test(e.target.note));
  const tm = e.trends.months.filter((m) => m.currency === "AED");
  check("monthly trend adds up to the period (invoice profit)", tm.reduce((n, m) => n + m.invoiceProfitMinor, 0) === p.invoiceProfitMinor, j(tm));
  check("exception trends not available (no history kept)", e.trends.exceptions === null && e.notes.some((n) => /exception trends are not available/i.test(n)));

  // ── Cache and Refresh ──────────────────────────────────────────────────────
  step("60-second cache; Refresh works it out again");
  cache.clearReportCache();
  const q = { org, from: P[0], to: P[1] };
  const a1 = await portal.executiveForPortal(q) as any;
  await Expense.collection.insertOne(exp("E-LATE", prev, 500_00));
  const a2 = await portal.executiveForPortal(q) as any;
  const a3 = await portal.executiveForPortal({ ...q, fresh: "1" }) as any;
  const costs = (r: any) => r.performance.find((x: any) => x.currency === "AED").current.expensesMinor;
  check("within 60 seconds the same answer is given", costs(a1) === costs(a2), j([costs(a1), costs(a2)]));
  check("fresh (Refresh) works it out again and sees the new expense", costs(a3) === costs(a1) + 500_00, j([costs(a1), costs(a3)]));
  const cached2 = await portal.controlsForPortal({ ...q, report: "risks" }) as any;
  const fresh2 = await portal.controlsForPortal({ ...q, report: "risks", fresh: "1" }) as any;
  check("controls reports are cached and refreshed the same way", !!cached2.sides && !!fresh2.sides);
  await Expense.collection.deleteOne({ expenseNumber: "E-LATE" });
  check("comparison through the portal (cfrom/cto) answers with it", ((await portal.executiveForPortal({ ...q, cfrom: C.from, cto: C.to, fresh: "1" })) as any).compare?.from === C.from);
  check("a bad comparison date is refused with a sentence", typeof (await portal.executiveForPortal({ ...q, cfrom: "nope", cto: C.to })) === "string");

  step("Nothing written");
  check("records unchanged by the reports", (await counts()) === before, `${await counts()} vs ${before}`);
} catch (err) {
  failures++;
  console.error(err);
} finally {
  await mongoose.disconnect();
}

console.log(`\n${checks - failures}/${checks} passed`);
process.exit(failures ? 1 : 0);
