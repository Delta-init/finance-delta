import { baseCurrencyOf } from "./reports.service";
import { managementRows, sidesOf as mpSides, monthsOf, type MPRow, type MPView } from "./management-profit.service";
import { financialReport, type FPReport, type FPSide } from "./financial-position.service";
import { reconciliationReport } from "./reconciliation.service";
import { controlsReport } from "./controls.service";
import { cached } from "./report-cache";

/*
 * The Executive Dashboard (Phase 7, 2026-11-28): one answer for Root's executive page, put together from the reports
 * earlier phases already work out — nothing is calculated again here, and nothing is calculated in the browser:
 *
 *   performance  Phase 3 management profitability (invoice-based, collection-based, cash movement), with gross and
 *                net invoiced and collected figures from the same records; the comparison period beside it.
 *   cash         Phase 4 cash flow (opening, in, out, net, closing) and cash position; Phase 6 liquidity (obligations
 *                due within 30 days or undated, potential surplus or shortfall).
 *   receivables  Phase 4 receivables (invoices, conditional instalments, old books apart, overdue) and obligations.
 *   alerts       Phase 5 and Phase 6 indicators.
 *   trends       the months of the above; expense categories; receivables ageing; obligations by kind. Exception
 *                trends are not available — exceptions are worked out from current records, no history is kept.
 *
 * Target: finance keeps no revenue target, so none is shown (approved 2026-11-28: "Not configured"). Each currency
 * stays apart; nothing is converted. Read-only.
 */

type Perf = {
  grossInvoicedMinor: number; netInvoicedMinor: number; collectionsMinor: number; netCollectionsMinor: number; expensesMinor: number;
  invoiceProfitMinor: number; invoiceMarginPct: number | null; collectionProfitMinor: number; collectionMarginPct: number | null;
  cashInMinor: number; cashOutMinor: number; cashNetMinor: number;
};
const pct = (net: number, inc: number) => (inc > 0 ? Math.round((net / inc) * 1000) / 10 : null);
const T = (s: FPSide | undefined, k: string) => s?.totals.find((t) => t.key === k)?.amountMinor ?? 0;
const L = (s: FPSide | undefined, k: string) => s?.sections.flatMap((x) => x.lines).find((l) => l.key === k)?.amountMinor ?? 0;
const SEC = (s: FPSide | undefined, k: string) => s?.sections.find((x) => x.key === k)?.totalMinor ?? 0;

const fpCached = (orgId: string, r: FPReport, from: string, to: string, fresh: boolean) => cached(`fp:${orgId}:${r}:${from}:${to}`, () => financialReport(orgId, r, from, to), fresh);
const mpCached = (orgId: string, v: MPView, from: string, to: string, fresh: boolean) => cached(`mprows:${orgId}:${v}:${from}:${to}`, () => managementRows(orgId, from, to, v), fresh);

/** Phase 3's three views for a period, per currency — and by month. */
async function performanceOf(orgId: string, from: string, to: string, fresh: boolean) {
  const [inv, col, cash] = await Promise.all([mpCached(orgId, "invoice", from, to, fresh), mpCached(orgId, "collection", from, to, fresh), mpCached(orgId, "cash", from, to, fresh)]);
  const base = inv.base;
  const build = (rows: { inv: MPRow[]; col: MPRow[]; cash: MPRow[] }) => {
    const si = mpSides(rows.inv, base), sc = mpSides(rows.col, base), sk = mpSides(rows.cash, base);
    const currencies = [...new Set([...si, ...sc, ...sk].map((s) => s.currency))];
    return currencies.map((c) => {
      const a = si.find((s) => s.currency === c), b = sc.find((s) => s.currency === c), k = sk.find((s) => s.currency === c);
      const income = (rs: MPRow[]) => rs.filter((r) => r.currency === c && r.group === "income");
      const perf: Perf = {
        grossInvoicedMinor: income(rows.inv).reduce((n, r) => n + (r.grossMinor ?? r.amountMinor), 0),
        netInvoicedMinor: a?.income.total ?? 0,
        collectionsMinor: income(rows.col).reduce((n, r) => n + (r.grossMinor ?? r.amountMinor), 0),
        netCollectionsMinor: b?.income.total ?? 0,
        expensesMinor: a?.expenses.total ?? 0,
        invoiceProfitMinor: a?.netMinor ?? 0, invoiceMarginPct: a ? a.marginPct : null,
        collectionProfitMinor: b?.netMinor ?? 0, collectionMarginPct: b ? b.marginPct : null,
        cashInMinor: k?.income.total ?? 0, cashOutMinor: k?.expenses.total ?? 0, cashNetMinor: k?.netMinor ?? 0,
      };
      return { currency: c, perf };
    });
  };
  const all = build({ inv: inv.rows, col: col.rows, cash: cash.rows });
  const months = monthsOf(from, to).map((month) => ({ month, sides: build({ inv: inv.rows.filter((r) => r.month === month), col: col.rows.filter((r) => r.month === month), cash: cash.rows.filter((r) => r.month === month) }) }));
  // Costs by category (invoice-based, the costs incurred).
  const categories = new Map<string, number>();
  for (const r of inv.rows) if (r.group !== "income") categories.set(`${r.currency}|${r.group}|${r.category || r.group}`, (categories.get(`${r.currency}|${r.group}|${r.category || r.group}`) ?? 0) + r.amountMinor);
  const expenseCategories = [...categories.entries()].map(([k, amountMinor]) => { const [currency, group, category] = k.split("|"); return { currency: currency!, group: group!, category: category!, amountMinor }; }).sort((x, y) => y.amountMinor - x.amountMinor);
  return { base, all, months, expenseCategories };
}

export async function executiveReport(orgId: string, from: string, to: string, compare: { from: string; to: string } | null, fresh = false) {
  const base = (await baseCurrencyOf(orgId)).toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const asOf = to > today ? today : to;
  const warnings: string[] = [];
  const [perf, perfCmp, cf, cfCmp, cash, rec, obl, adv, liq, rc, fc] = await Promise.all([
    performanceOf(orgId, from, to, fresh),
    compare ? performanceOf(orgId, compare.from, compare.to, fresh) : Promise.resolve(null),
    fpCached(orgId, "cashflow", from, to, fresh),
    compare ? fpCached(orgId, "cashflow", compare.from, compare.to, fresh) : Promise.resolve(null),
    fpCached(orgId, "cash", from, to, fresh),
    fpCached(orgId, "receivables", from, to, fresh),
    fpCached(orgId, "obligations", from, to, fresh),
    fpCached(orgId, "advances", from, to, fresh),
    cached(`fc:${orgId}:liquidity:${from}:${to}`, () => controlsReport(orgId, "liquidity", from, to), fresh),
    cached(`rc:${orgId}:summary:${from}:${to}`, () => reconciliationReport(orgId, "summary", from, to), fresh),
    cached(`fc:${orgId}:overview:${from}:${to}`, () => controlsReport(orgId, "overview", from, to), fresh),
  ]);
  for (const w of [...cash.warnings, ...obl.warnings, ...adv.warnings]) if (!warnings.includes(w)) warnings.push(w);
  const currencies = [...new Set([base, ...perf.all.map((p) => p.currency), ...cf.sides.map((s) => s.currency), ...rec.sides.map((s) => s.currency), ...obl.sides.map((s) => s.currency)])];

  const performance = currencies.map((c) => ({ currency: c, current: perf.all.find((p) => p.currency === c)?.perf ?? null, compare: perfCmp ? perfCmp.all.find((p) => p.currency === c)?.perf ?? null : null }));
  const flowOf = (s: FPSide | undefined) => (s ? { openingMinor: T(s, "opening"), inflowsMinor: T(s, "inflows"), outflowsMinor: T(s, "outflows"), netMinor: T(s, "net"), closingMinor: T(s, "closing"), checkMinor: T(s, "check") } : null);
  const cashOut = currencies.map((c) => {
    const cs = cash.sides.find((s) => s.currency === c), ls = liq.sides.find((s) => s.currency === c), os = obl.sides.find((s) => s.currency === c);
    const confirmed = cs?.totals.find((t) => t.key === "confirmed");
    return {
      currency: c,
      flow: flowOf(cf.sides.find((s) => s.currency === c)), flowCompare: cfCmp ? flowOf(cfCmp.sides.find((s) => s.currency === c)) : null,
      availableMinor: T(cs, "available"), pspMinor: T(cs, "psp"), negativeMinor: T(cs, "negative"),
      verifiedMinor: confirmed?.amountMinor ?? 0, verifiedLabel: confirmed?.label ?? "Confirmed by a reconciled statement: none",
      obligationsMinor: T(os, "total"), availableAfterMinor: T(cs, "available") - T(os, "total"),
      nearObligationsMinor: T(ls, "near"), surplusMinor: T(ls, "shortfall"), // + surplus, − shortfall (FC-04)
    };
  });
  const receivables = currencies.map((c) => {
    const s = rec.sides.find((x) => x.currency === c);
    return { currency: c, totalMinor: T(s, "outstanding"), invoicesMinor: L(s, "kind:invoice"), enrolmentMinor: L(s, "kind:enrolment"), conditionalMinor: L(s, "kind:proforma"), oldBooksMinor: L(s, "kind:old_books"), overdueMinor: T(s, "overdue"), dueMinor: T(s, "enforceable"),
      ageing: (s?.sections.find((x) => x.key === "age")?.lines ?? []).map((l) => ({ key: l.key.split(":")[1]!, label: l.label, amountMinor: l.amountMinor, count: l.count })) };
  });
  const obligations = currencies.map((c) => {
    const s = obl.sides.find((x) => x.currency === c), a = adv.sides.find((x) => x.currency === c);
    return { currency: c, billsMinor: L(s, "obl:bills"), salariesMinor: L(s, "obl:salaries"), commissionMinor: L(s, "obl:commission"), expensesMinor: L(s, "obl:expenses"), reimbursementsMinor: L(s, "obl:reimbursements"), loansMinor: L(s, "obl:loans"), totalMinor: T(s, "total"),
      advancesOutstandingMinor: T(a, "outstanding"), advancesNotCalculableMinor: T(a, "unknown") };
  });
  const alerts = currencies.flatMap((c) => {
    const ind = (list: { currency: string; key: string; value: number | null }[], key: string) => list.find((i) => i.currency === c && i.key === key)?.value ?? null;
    const f = fc.indicators, r = rc.indicators;
    const out: { currency: string; key: string; label: string; value: number | null; as: "money" | "count"; section: string; report: string; note?: string }[] = [];
    const add = (key: string, label: string, value: number | null, as: "money" | "count", section: string, report: string, note?: string) => out.push({ currency: c, key, label, value, as, section, report, ...(note ? { note } : {}) });
    add("pending", "Pending approvals", ind(f, "pending"), "count", "controls", "fc-02");
    add("overdue", "Overdue approvals (more than 3 days)", ind(f, "overdue"), "count", "controls", "fc-02");
    add("critical", "Critical financial exceptions", ind(f, "critical"), "count", "controls", "fc-03");
    add("high", "High-priority financial exceptions", ind(f, "high"), "count", "controls", "fc-03");
    add("unreconciled", "Unreconciled bank accounts", ind(f, "unreconciled"), "count", "reconciliation", "rc-01");
    add("unmatched_in", "Unmatched bank money in", ind(r, "unmatched_in"), "money", "reconciliation", "rc-01");
    add("unmatched_out", "Unmatched bank money out", ind(r, "unmatched_out"), "money", "reconciliation", "rc-01");
    add("open_differences", "Open reconciliation differences (unverified — not losses)", ind(r, "differences"), "money", "reconciliation", "rc-01");
    add("psp_overdue", "PSP payments overdue for settlement", ind(f, "psp_overdue"), "count", "controls", "fc-04");
    add("duplicates", "Potential duplicate transactions", ind(r, "duplicates"), "count", "reconciliation", "rc-08");
    add("negative", "Negative bank balances", cashOut.find((x) => x.currency === c)?.negativeMinor ?? 0, "money", "controls", "fc-04");
    add("doc_gaps", "Financial documentation gaps", ind(f, "doc_gaps"), "count", "controls", "fc-05");
    if (c === base) add("closing", f.find((i) => i.key === "closing")?.label ?? "Closing readiness", ind(f, "closing"), "count", "controls", "fc-08", "Readiness only — no period is closed");
    return out;
  });
  const trends = {
    months: perf.months.flatMap((m) => m.sides.map((s) => ({ month: m.month, currency: s.currency, ...s.perf }))),
    cash: cf.months.flatMap((m) => m.sides.map((s) => ({ month: m.month, currency: s.currency, ...flowOf(s)! }))),
    expenseCategories: perf.expenseCategories,
    exceptions: null as null,
  };
  return {
    report: "executive", currency: base, from, to, asOf, compare,
    target: { valueMinor: null as number | null, note: "Not configured — finance keeps no revenue target." },
    performance, cash: cashOut, receivables, obligations, alerts, trends,
    notes: [
      "Every figure comes from finance's reports (Phases 3–6); nothing is worked out again here or in the browser. Invoice-based profitability, collection-based profitability and cash movement are kept apart.",
      "Receivables: issued invoices and enrolment balances are due, not guaranteed collectible; pro-forma balances are conditional future instalments; old-books balances are apart.",
      "Bank balances are system-recorded; a verified balance needs a completed reconciliation. Open reconciliation differences are unverified statement figures, not losses.",
      "Financial exception trends are not available: exceptions are worked out from current records each time and no history is kept.",
    ],
    warnings,
  };
}
