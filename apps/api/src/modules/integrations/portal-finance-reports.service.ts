import { Types } from "mongoose";
import type { AnalysisForeign, AnalysisReport } from "@delta/shared";
import { Organization } from "../organization/organization.model";
import { BankAccount } from "../banking/bank-account.model";
import { analysisFilters, EXPENSE_DIMENSION_KEYS, getExpenseAnalysis, getRevenueAnalysis, REVENUE_DIMENSION_KEYS, type AnalysisQuery } from "../reports/analysis.service";
import { getAgedPayables, getAgedReceivables, getProfitLoss, getVATReport } from "../reports/reports.service";
import { Invoice } from "../invoice/invoice.model";
import { User } from "../user/user.model";
import { Department } from "../department/department.model";

/*
 * The Root portal's Report Org → Finance and revenue (the user, 2026-11-26: "first I need report finance and revenue").
 *
 *   GET /api/v1/service/reports/organizations          the organizations here, each with its currency
 *   GET /api/v1/service/reports/overview?org&from&to   one organization's headline figures for a period
 *   GET /api/v1/service/reports/revenue?org&from&to…   the Revenue report — invoiced or collected, grouped and filtered
 *   GET /api/v1/service/reports/expenses?org&from&to…  the Expense report — by expense or paid date, grouped and filtered
 *   GET /api/v1/service/reports/aging?org&kind…        what is still owed, by invoice or by bill, as of now
 *
 * Nothing is worked out twice: every figure comes from the functions finance's own pages use (the Revenue report, the
 * aged lists, the Profit & Loss, the VAT report), so a number in Root is the number on finance's screen. One
 * organization per call, in its own currency — two organizations are never added together, here or in Root.
 *
 * Read-only. Reached with Root's secret alone (no role is checked here), so Root decides who may see it.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** The longest period one call reads — three years, for the annual report. */
const MAX_DAYS = 1100;
const DAY_MS = 86_400_000;
/** Rows on one page of a report's table when none is asked for, and the most one call gives — an export takes them all. */
const RECORDS = 50;
const MAX_RECORDS = 5000;

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
const iso = (d: Date) => d.toISOString().slice(0, 10);
const utc = (day: string) => new Date(`${day}T00:00:00.000Z`);

type Org = { id: string; name: string; currency: string };

export async function organizationsForPortal(): Promise<Org[]> {
  const orgs = (await Organization.find().select("name baseCurrency").sort({ createdAt: 1 }).lean()) as unknown as { _id: Types.ObjectId; name: string; baseCurrency?: string }[];
  return orgs.map((o) => ({ id: String(o._id), name: o.name, currency: (o.baseCurrency || "AED").toUpperCase() }));
}

/** The organization asked for — the first when none is — or a sentence saying what is wrong. */
async function organizationOf(q: Record<string, unknown>): Promise<Org | string> {
  const orgs = await organizationsForPortal();
  const want = str(q.org);
  const org = want ? orgs.find((o) => o.id === want) : orgs[0];
  return org ?? (want ? "No such organization" : "No organization here");
}

/*
 * Payments made in another currency than their invoice's — rupees on an AED invoice (the user, 2026-11-26: "if they
 * collected INR payments it needs to show as INR instead of summing in the AED, same as the finance payment stats
 * card"). The Revenue report keeps them out of Collected and gives them apart, as they were paid: a line per currency
 * on the report, on each group, and — worked out here — on each day. Root gets them the same way and never converts
 * one or adds it in.
 */

/** How many such payments a report has, whatever their currency — for "the newest N of M". */
const foreignCount = (report: AnalysisReport) => (report.foreign?.lines ?? []).reduce((n, l) => n + l.count, 0);

/** The period asked for, or a sentence saying what is wrong with it. */
function periodOf(q: Record<string, unknown>): { from: string; to: string } | string {
  const from = str(q.from), to = str(q.to);
  for (const [key, v] of [["from", from], ["to", to]] as const) {
    if (!DAY.test(v) || Number.isNaN(utc(v).getTime())) return `${key} is a date, YYYY-MM-DD`;
  }
  if (from > to) return "The period ends before it starts";
  if ((utc(to).getTime() - utc(from).getTime()) / DAY_MS + 1 > MAX_DAYS) return "The period is longer than three years";
  return { from, to };
}

/**
 * The period before, to compare with: a whole month is compared with the month before it and a whole year with the
 * year before, anything else with the same number of days ending the day before it starts.
 */
export function periodBefore(from: string, to: string): { from: string; to: string } {
  const f = utc(from), t = utc(to);
  const lastOfMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const sameMonth = f.getUTCFullYear() === t.getUTCFullYear() && f.getUTCMonth() === t.getUTCMonth();
  if (sameMonth && f.getUTCDate() === 1 && t.getUTCDate() === lastOfMonth(t)) {
    return { from: iso(new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() - 1, 1))), to: iso(new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 0))) };
  }
  const wholeYear = f.getUTCFullYear() === t.getUTCFullYear() && f.getUTCMonth() === 0 && f.getUTCDate() === 1 && t.getUTCMonth() === 11 && t.getUTCDate() === 31;
  if (wholeYear) return { from: `${f.getUTCFullYear() - 1}-01-01`, to: `${f.getUTCFullYear() - 1}-12-31` };
  const days = Math.round((t.getTime() - f.getTime()) / DAY_MS) + 1;
  return { from: iso(new Date(f.getTime() - days * DAY_MS)), to: iso(new Date(f.getTime() - DAY_MS)) };
}

type Day = { day: string; amountMinor: number; count: number; foreign?: AnalysisForeign[] };

/**
 * Each day's total in the report's currency, and beside it what was paid that day in any other (a day with rupees
 * only has nothing in `amountMinor`). Null when more matched than the report lists, of either, so a day could be short.
 */
function daysOf(report: AnalysisReport): Day[] | null {
  const away = report.foreign?.records ?? [];
  if (report.capped || away.length < foreignCount(report)) return null;
  const by = new Map<string, Day>();
  const at = (day: string) => by.get(day) ?? by.set(day, { day, amountMinor: 0, count: 0 }).get(day)!;
  for (const r of report.records) {
    const d = at(r.date);
    d.amountMinor += r.amountMinor;
    d.count++;
  }
  for (const r of away) {
    const lines = (at(r.date).foreign ??= []);
    const currency = String(r.currency).toUpperCase();
    const line = lines.find((l) => l.currency === currency) ?? lines[lines.push({ currency, amountMinor: 0, count: 0 }) - 1]!;
    line.amountMinor += r.amountMinor;
    line.count++;
  }
  return [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
}

const query = (period: { from: string; to: string }, basis: string, groupBy: string, filters: Record<string, string> = {}, search = ""): AnalysisQuery =>
  ({ from: period.from, to: period.to, basis, groupBy, filters, search });

/*
 * A report's records as rows for Root's tables (the user, 2026-11-26: "show table only, with filter and pagination and
 * columns reorder"): every record that matched — in the report's own currency and, apart, any paid in another — with
 * each dimension by its name rather than its key, sorted as asked and given a page at a time.
 *
 * Searching (?q=) is the report's own search, so the totals and the groups are of what the search kept, and a page
 * of rows never disagrees with the total under it. The report lists at most its newest 5,000 records of each kind;
 * `rowCount` is how many rows there are to page through, `recordCount` how many matched.
 */
type Row = Record<string, unknown>;

/**
 * An invoice raised from CS Portal carries CS Portal's own source code where a sales CRM's carries the CRM, and the
 * Revenue report gives that code as the name. Root's CRM filter says what it is (the user, 2026-11-27: "add CS Portal
 * filter also").
 */
const CRM_NAMES: Record<string, string> = { "tetra-course": "CS Portal", "tetra-commission": "CS Portal (earlier)" };
function nameCrms(report: AnalysisReport): void {
  for (const o of report.options.crm ?? []) if (CRM_NAMES[o.key]) o.name = CRM_NAMES[o.key]!;
  if (report.groupBy === "crm") for (const g of report.groups) if (CRM_NAMES[g.key]) g.name = CRM_NAMES[g.key]!;
}

function rowsOf(report: AnalysisReport, dims: readonly string[]): Row[] {
  const names = new Map(dims.map((dim) => [dim, new Map((report.options[dim] ?? []).map((o) => [o.key, o.name]))]));
  return [...report.records, ...(report.foreign?.records ?? [])].map((r) => {
    const row: Row = { id: r.id, date: r.date, number: r.number, title: r.title, detail: r.detail, amountMinor: r.amountMinor, href: r.href };
    if (r.currency) row.currency = r.currency;
    if (r.collectedMinor !== undefined) row.collectedMinor = r.collectedMinor;
    if (r.owedMinor !== undefined) row.owedMinor = r.owedMinor;
    if (r.recordedMinor !== undefined) row.recordedMinor = r.recordedMinor;
    if (r.paidIn) row.paidIn = r.paidIn;
    for (const dim of dims) {
      const key = r.dims[dim];
      if (key !== undefined) row[dim] = names.get(dim)?.get(key) ?? key;
    }
    return row;
  });
}

/**
 * One page of rows, sorted by a column: the date, the number, the title, the amount, or a dimension's name. Amounts
 * are ordered by what finance recorded in the report's own currency, so a rupee payment sits where its dirham value
 * puts it rather than above everything for having the bigger number. Ties go newest first.
 */
function pageOf(rows: Row[], q: Record<string, unknown>, dims: readonly string[]) {
  const wanted = str(q.sort);
  const key = ["date", "number", "title", "amount", ...dims].includes(wanted) ? wanted : "date";
  const dir = str(q.dir) === "asc" ? 1 : -1;
  const value = (r: Row): string | number => (key === "amount" ? Number(r.recordedMinor ?? r.amountMinor) || 0 : typeof r[key] === "number" ? (r[key] as number) : String(r[key] ?? ""));
  rows.sort((a, b) => {
    const x = value(a), y = value(b);
    const by = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" });
    return by * dir || String(b.date).localeCompare(String(a.date));
  });
  const limit = Math.min(MAX_RECORDS, Math.max(0, Math.floor(Number(q.limit ?? RECORDS)) || 0));
  const offset = Math.max(0, Math.floor(Number(q.offset)) || 0);
  return { rows: rows.slice(offset, offset + limit), rowCount: rows.length, offset, sort: key, dir: dir === 1 ? "asc" : "desc" };
}

/** The dimensions a revenue row carries by name — the client is the row's title and the month is in its date. */
const REVENUE_ROW_DIMENSIONS = REVENUE_DIMENSION_KEYS.filter((d) => d !== "customer" && d !== "month");
const EXPENSE_ROW_DIMENSIONS = EXPENSE_DIMENSION_KEYS.filter((d) => d !== "month");

/**
 * The Expense report's total in the organization's own currency — nothing when the period has none in it — and every
 * other currency's total apart.
 *
 * The overview's expenses come from here and not from the Profit & Loss: the P&L adds every expense's amount together
 * whatever its currency, so INR 20,000 went into an AED total as 20,000 dirhams (found testing, 2026-11-26). The
 * Expense report keeps currencies apart, and its profit-and-loss total is what the Report Org's expense reports show.
 */
function ownExpenses(report: AnalysisReport, own: string) {
  const by = report.byCurrency?.length ? report.byCurrency : [{ currency: report.currency, amountMinor: report.totals.amountMinor, count: report.totals.count }];
  const mine = by.find((c) => c.currency === own);
  return {
    minor: mine?.amountMinor ?? 0,
    count: mine?.count ?? 0,
    other: by.filter((c) => c.currency !== own && c.count > 0).map((c) => ({ currency: c.currency, amountMinor: c.amountMinor, count: c.count })),
  };
}

/**
 * One organization's headline figures for a period, each beside the period before.
 *
 * Invoiced and collected are the Revenue report's totals; income is the Profit & Loss's (invoices before VAT);
 * expenses are the Expense report's profit-and-loss total in the organization's currency; and the profit is the one
 * less the other — finance keeps no ledger, so this is not a posted-ledger profit and Root says so. What is owed
 * either way is as of now, whatever the period; the bank balances are what each account holds now.
 */
export async function financeOverviewForPortal(q: Record<string, unknown>) {
  const org = await organizationOf(q);
  if (typeof org === "string") return org;
  const period = periodOf(q);
  if (typeof period === "string") return period;
  const before = periodBefore(period.from, period.to);
  const filters = analysisFilters(q, ["crm"]);

  const pnlExpenses = (p: { from: string; to: string }) => getExpenseAnalysis(org.id, { ...query(p, "expense", "category"), pnlOnly: true, currency: org.currency });
  const [invoiced, collected, invoicedBefore, collectedBefore, pl, plBefore, receivables, payables, vat, accounts, spent, spentBefore] = await Promise.all([
    getRevenueAnalysis(org.id, query(period, "invoiced", "month", filters)),
    getRevenueAnalysis(org.id, query(period, "collected", "method", filters)),
    getRevenueAnalysis(org.id, query(before, "invoiced", "month", filters)),
    getRevenueAnalysis(org.id, query(before, "collected", "method", filters)),
    getProfitLoss(org.id, period.from, period.to, org.currency),
    getProfitLoss(org.id, before.from, before.to, org.currency),
    getAgedReceivables(org.id, org.currency),
    getAgedPayables(org.id, org.currency),
    getVATReport(org.id, period.from, period.to, org.currency),
    BankAccount.find({ organizationId: new Types.ObjectId(org.id), isActive: true })
      .select("accountName accountType currency currentBalanceMinor").sort({ accountType: 1, accountName: 1 })
      .lean<{ accountName: string; accountType: string; currency: string; currentBalanceMinor: number }[]>(),
    pnlExpenses(period),
    pnlExpenses(before),
  ]);
  // Expenses in the organization's own currency, and any other currency's apart — see ownExpenses.
  const mine = ownExpenses(spent, org.currency), mineBefore = ownExpenses(spentBefore, org.currency);

  const pair = (minor: number | undefined, priorMinor: number | undefined) => ({ minor: minor ?? 0, priorMinor: priorMinor ?? 0 });
  // The two bases day by day, for the trend — left out when either had more records than a call lists.
  const invoicedDays = daysOf(invoiced), collectedDays = daysOf(collected);
  let trend: { day: string; invoicedMinor: number; collectedMinor: number }[] | null = null;
  if (invoicedDays && collectedDays) {
    const by = new Map<string, { day: string; invoicedMinor: number; collectedMinor: number }>();
    const at = (day: string) => by.get(day) ?? by.set(day, { day, invoicedMinor: 0, collectedMinor: 0 }).get(day)!;
    for (const d of invoicedDays) at(d.day).invoicedMinor = d.amountMinor;
    for (const d of collectedDays) at(d.day).collectedMinor = d.amountMinor;
    trend = [...by.values()].sort((a, b) => a.day.localeCompare(b.day));
  }
  // Balances per currency — an account in rupees is never added to one in dirhams.
  const balances = new Map<string, number>();
  for (const a of accounts) balances.set(a.currency, (balances.get(a.currency) ?? 0) + (a.currentBalanceMinor ?? 0));

  return {
    generatedAt: new Date().toISOString(),
    org, period, before,
    // Asked only of the money that came through one CRM; the P&L, what is owed and the bank are the organization's whole.
    crm: filters.crm ? filters.crm.split("\u001f") : null,
    kpis: {
      grossInvoiced: { ...pair(invoiced.totals.invoicedMinor, invoicedBefore.totals.invoicedMinor), count: invoiced.totals.count },
      creditNotes: pair(invoiced.totals.creditMinor, invoicedBefore.totals.creditMinor),
      netInvoiced: pair(invoiced.totals.amountMinor, invoicedBefore.totals.amountMinor),
      collections: { ...pair(collected.totals.amountMinor, collectedBefore.totals.amountMinor), count: collected.totals.count },
      income: pair(pl.income.total, plBefore.income.total),
      expenses: { ...pair(mine.minor, mineBefore.minor), count: mine.count },
      netProfit: pair(pl.income.total - mine.minor, plBefore.income.total - mineBefore.minor),
    },
    receivables: { asOf: receivables.asOf, ...receivables.totals },
    payables: { asOf: payables.asOf, ...payables.totals },
    vat: { outputMinor: vat.outputTaxMinor, inputMinor: vat.inputTaxMinor, netPayableMinor: vat.netPayableMinor },
    // A method taken in another currency only (INR Transfer) has nothing in `amountMinor`: its money is in `foreign`.
    methods: collected.groups.map((g) => ({ key: g.key, name: g.name, amountMinor: g.amountMinor, count: g.count, ...(g.foreign?.length ? { foreign: g.foreign } : {}) })),
    // Collected in another currency than the invoices' — a line per currency, as paid; not in `collections` above,
    // nor in the trend, which is the organization's own currency.
    collectedForeign: collected.foreign ? { lines: collected.foreign.lines } : null,
    // Expenses in another currency than the organization's — apart, never in `expenses` or the profit above.
    expensesOther: mine.other,
    expenseCategories: spent.currency === org.currency ? spent.groups.map((g) => ({ label: g.name, amountMinor: g.amountMinor })) : [],
    trend,
    bank: {
      accounts: accounts.map((a) => ({ name: a.accountName, type: a.accountType, currency: a.currency, balanceMinor: a.currentBalanceMinor ?? 0 })),
      byCurrency: [...balances.entries()].map(([currency, balanceMinor]) => ({ currency, balanceMinor })),
    },
  };
}

/**
 * The Revenue report for Root: invoiced (by issue date, less credit notes) or collected (by payment date), grouped by
 * one of its dimensions — or by day — and kept to any of them (?crm=draw&course=…).
 *
 * The groups, the months and the totals are of everything that matched; the records listed are the newest `limit`.
 */
export async function revenueReportForPortal(q: Record<string, unknown>) {
  const org = await organizationOf(q);
  if (typeof org === "string") return org;
  const period = periodOf(q);
  if (typeof period === "string") return period;
  const basis = str(q.basis) || "invoiced";
  if (basis !== "invoiced" && basis !== "collected") return "basis is invoiced or collected";
  const wanted = str(q.groupBy) || "month";
  const byDay = wanted === "day";
  if (!byDay && !(REVENUE_DIMENSION_KEYS as readonly string[]).includes(wanted)) return `groupBy is day or one of ${REVENUE_DIMENSION_KEYS.join(", ")}`;

  const report = await getRevenueAnalysis(org.id, query(period, basis, byDay ? "month" : wanted, analysisFilters(q, REVENUE_DIMENSION_KEYS), str(q.q).slice(0, 100)));
  nameCrms(report);
  const page = pageOf(rowsOf(report, REVENUE_ROW_DIMENSIONS), q, REVENUE_ROW_DIMENSIONS);
  // Every customer of the period is too long a list to send for a filter nobody picks from.
  const { customer: _customers, ...options } = report.options;
  return {
    generatedAt: new Date().toISOString(),
    org, period,
    basis, groupBy: wanted, currency: report.currency,
    totals: report.totals,
    groups: byDay ? [] : report.groups,
    months: report.months,
    // Day by day — null when more records matched than one call reads, so the days could be short.
    days: daysOf(report),
    options,
    ...page,
    // Every record that matched, in whichever currency; `rowCount` is how many of them there are to page through.
    recordCount: report.totals.count + foreignCount(report),
    capped: report.capped,
    foreign: report.foreign ? { lines: report.foreign.lines } : null,
  };
}

/**
 * The Expense report for Root (the user, 2026-11-26: expenses next): approved expenses and those waiting for approval,
 * dated by the expense date or the day paid, grouped by one of its dimensions — or by day — and kept to any of them
 * (?source=hrms_reimbursement). A supplier bill's expense is in it too.
 *
 * Profit-and-loss expenses only unless ?pnl=0 — what the categories say is an expense, leaving out advances, payroll
 * clearing, VAT and loan principal — so the total is the one the overview's Expenses figure is made of.
 *
 * One currency at a time, never two added: `currency` is the one shown (asked with ?currency=, else the
 * organization's), and `byCurrency` has every currency's own totals for the cards.
 */
export async function expensesReportForPortal(q: Record<string, unknown>) {
  const org = await organizationOf(q);
  if (typeof org === "string") return org;
  const period = periodOf(q);
  if (typeof period === "string") return period;
  const basis = str(q.basis) || "expense";
  if (basis !== "expense" && basis !== "paid") return "basis is expense or paid";
  const wanted = str(q.groupBy) || "month";
  const byDay = wanted === "day";
  if (!byDay && !(EXPENSE_DIMENSION_KEYS as readonly string[]).includes(wanted)) return `groupBy is day or one of ${EXPENSE_DIMENSION_KEYS.join(", ")}`;
  const pnlOnly = !["0", "false"].includes(str(q.pnl));

  const report = await getExpenseAnalysis(org.id, {
    ...query(period, basis, byDay ? "month" : wanted, analysisFilters(q, EXPENSE_DIMENSION_KEYS), str(q.q).slice(0, 100)),
    pnlOnly, currency: str(q.currency).toUpperCase() || undefined,
  });
  const page = pageOf(rowsOf(report, EXPENSE_ROW_DIMENSIONS), q, EXPENSE_ROW_DIMENSIONS);
  return {
    generatedAt: new Date().toISOString(),
    org, period,
    basis, groupBy: wanted, pnlOnly,
    currency: report.currency,
    currencies: report.currencies ?? [report.currency],
    byCurrency: report.byCurrency ?? [],
    totals: report.totals,
    groups: byDay ? [] : report.groups,
    months: report.months,
    days: daysOf(report),
    // Every value each dimension has in the period, for the filters.
    options: report.options,
    ...page,
    recordCount: report.totals.count,
    capped: report.capped,
  };
}

const BANDS = [
  { key: "current", name: "Not yet due" },
  { key: "band1to30", name: "1–30 days late" },
  { key: "band31to60", name: "31–60 days late" },
  { key: "band61to90", name: "61–90 days late" },
  { key: "band90plus", name: "Over 90 days late" },
] as const;

/**
 * What is still owed, for Root (the user, 2026-11-27: "connect receivables and payables next"): every open invoice
 * (kind=receivables) or open bill (kind=payables) of one organization as finance's own aged lists give them — what is
 * left on each, when it was due and how late it is — as of now. Finance keeps balances as they stand, not as they
 * stood, so there is no period to ask for; and it keeps no instalment schedule, so "due" is the invoice's own due date.
 *
 * ?due=upcoming keeps what is not yet due, ?due=overdue what is past due; ?q= searches the number and the name.
 * Grouped by how late (the five bands, always all five) or, with groupBy=party, by student or vendor. In the
 * organization's own currency; what is owed in another is in `otherCurrencies`, apart, never added in.
 */
export async function agingReportForPortal(q: Record<string, unknown>) {
  const org = await organizationOf(q);
  if (typeof org === "string") return org;
  const kind = str(q.kind) || "receivables";
  if (kind !== "receivables" && kind !== "payables") return "kind is receivables or payables";
  const due = str(q.due);
  if (due && due !== "upcoming" && due !== "overdue") return "due is upcoming or overdue";
  const groupBy = str(q.groupBy) || "band";
  if (groupBy !== "band" && groupBy !== "party") return "groupBy is band or party";

  const report = kind === "receivables" ? await getAgedReceivables(org.id, org.currency) : await getAgedPayables(org.id, org.currency);
  const needle = str(q.q).slice(0, 100).toLowerCase();
  const every: Row[] = BANDS.flatMap((band) => report[band.key].map((item): Row => ({
    id: item.id, date: item.issuedDate, dueDate: item.dueDate, number: item.number, title: item.partyName, detail: "",
    amountMinor: item.balanceMinor, totalMinor: item.totalMinor, daysOverdue: Math.max(0, item.daysOverdue), band: band.name, bandKey: band.key,
    href: `/${kind === "receivables" ? "invoices" : "bills"}/${item.id}`,
  }))).filter((r) => (due === "upcoming" ? r.bandKey === "current" : due === "overdue" ? r.bandKey !== "current" : true));

  // An open invoice's salesperson and their department — the aged list has neither. A bill has no salesperson.
  if (kind === "receivables" && every.length) {
    const orgId = new Types.ObjectId(org.id);
    const [invoices, people, depts] = await Promise.all([
      Invoice.find({ _id: { $in: every.map((r) => new Types.ObjectId(String(r.id))) } }).select("salespersonId salespersonName").lean<{ _id: Types.ObjectId; salespersonId?: Types.ObjectId; salespersonName?: string }[]>(),
      User.find({ "memberships.organizationId": orgId }).select("memberships").lean<{ _id: Types.ObjectId; memberships?: { organizationId: Types.ObjectId; departmentId?: Types.ObjectId }[] }[]>(),
      Department.find({ organizationId: orgId }).select("name").lean<{ _id: Types.ObjectId; name: string }[]>(),
    ]);
    const deptName = new Map(depts.map((x) => [String(x._id), x.name]));
    const deptOf = new Map(people.map((u) => [String(u._id), deptName.get(String(u.memberships?.find((m) => String(m.organizationId) === org.id)?.departmentId ?? "")) ?? ""]));
    const byId = new Map(invoices.map((i) => [String(i._id), i]));
    for (const r of every) {
      const i = byId.get(String(r.id));
      r.salesperson = i?.salespersonName || "No salesperson";
      r.department = (i?.salespersonId && deptOf.get(String(i.salespersonId))) || "No department";
    }
  }

  // What each filter can be set to, counted before any of them is applied, so a list always offers what there is.
  const FILTERS = kind === "receivables" ? (["party", "band", "salesperson", "department"] as const) : (["party", "band"] as const);
  const field = (f: string) => (f === "party" ? "title" : f);
  const options: Record<string, { key: string; name: string; count: number }[]> = {};
  for (const f of FILTERS) {
    const counts = new Map<string, number>();
    for (const r of every) counts.set(String(r[field(f)] ?? ""), (counts.get(String(r[field(f)] ?? "")) ?? 0) + 1);
    options[f] = [...counts.entries()].map(([name, n]) => ({ key: name, name: name || "—", count: n }))
      .sort((a, b) => (f === "band" ? BANDS.findIndex((x) => x.name === a.key) - BANDS.findIndex((x) => x.name === b.key) : a.name.localeCompare(b.name)));
  }
  const asked = (f: string): string[] => (Array.isArray(q[f]) ? (q[f] as unknown[]) : [q[f]]).filter((x): x is string => typeof x === "string" && x !== "").slice(0, 50);
  const rows = every.filter((r) => FILTERS.every((f) => { const want = asked(f); return !want.length || want.includes(String(r[field(f)] ?? "")); })
    && (!needle || `${r.number} ${r.title}`.toLowerCase().includes(needle)));

  const sum = (list: Row[], key: string) => list.reduce((n, r) => n + (Number(r[key]) || 0), 0);
  const groups = groupBy === "band"
    ? BANDS.filter((b) => (due === "upcoming" ? b.key === "current" : due === "overdue" ? b.key !== "current" : true)).map((b) => {
      const list = rows.filter((r) => r.bandKey === b.key);
      return { key: b.key, name: b.name, count: list.length, amountMinor: sum(list, "amountMinor"), totalMinor: sum(list, "totalMinor") };
    })
    : [...rows.reduce((by, r) => {
      const name = String(r.title || "—");
      const g = by.get(name) ?? { key: name, name, count: 0, amountMinor: 0, totalMinor: 0, overdueMinor: 0 };
      g.count++;
      g.amountMinor += Number(r.amountMinor) || 0;
      g.totalMinor += Number(r.totalMinor) || 0;
      if (r.bandKey !== "current") g.overdueMinor += Number(r.amountMinor) || 0;
      return by.set(name, g);
    }, new Map<string, { key: string; name: string; count: number; amountMinor: number; totalMinor: number; overdueMinor: number }>()).values()]
      .sort((a, b) => b.amountMinor - a.amountMinor || a.name.localeCompare(b.name));

  const overdue = rows.filter((r) => r.bandKey !== "current");
  return {
    generatedAt: new Date().toISOString(),
    org, kind, due: due || null, groupBy, asOf: report.asOf, currency: org.currency,
    totals: { amountMinor: sum(rows, "amountMinor"), count: rows.length, totalMinor: sum(rows, "totalMinor"), overdueMinor: sum(overdue, "amountMinor"), overdueCount: overdue.length },
    groups,
    options,
    ...pageOf(rows, { sort: "dueDate", dir: "asc", ...q }, ["dueDate", "daysOverdue", "totalMinor", "salesperson", "department"]),
    recordCount: rows.length,
    capped: false,
    otherCurrencies: report.otherCurrencies ?? [],
  };
}
