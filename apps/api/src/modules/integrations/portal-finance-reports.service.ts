import { Types } from "mongoose";
import type { AnalysisForeign, AnalysisReport } from "@delta/shared";
import { Organization } from "../organization/organization.model";
import { BankAccount } from "../banking/bank-account.model";
import { analysisFilters, crmOf, EXPENSE_DIMENSION_KEYS, getExpenseAnalysis, getRevenueAnalysis, REVENUE_DIMENSION_KEYS, type AnalysisQuery } from "../reports/analysis.service";
import { getAgedPayables, getAgedReceivables, getProfitLoss, getVATReport } from "../reports/reports.service";
import { Invoice } from "../invoice/invoice.model";
import { User } from "../user/user.model";
import { Department } from "../department/department.model";
import { CrmCommissionPayout } from "../crm-commission/crm-commission-payout.model";
import { CsCommissionPayout } from "../cs-commission/cs-commission-payout.model";
import { PayrollRun } from "../payroll/payroll-run.model";
import { Bill } from "../bill/bill.model";

/*
 * The Root portal's Report Org → Finance and revenue (the user, 2026-11-26: "first I need report finance and revenue").
 *
 *   GET /api/v1/service/reports/organizations          the organizations here, each with its currency
 *   GET /api/v1/service/reports/overview?org&from&to   one organization's headline figures for a period
 *   GET /api/v1/service/reports/revenue?org&from&to…   the Revenue report — invoiced or collected, grouped and filtered
 *   GET /api/v1/service/reports/expenses?org&from&to…  the Expense report — by expense or paid date, grouped and filtered
 *   GET /api/v1/service/reports/aging?org&kind…        what is still owed, by invoice or by bill, as of now
 *   GET /api/v1/service/reports/commission?org&from&to… commission finance approved and paid, CRM and CS
 *   GET /api/v1/service/reports/payroll?org&from&to…   payroll runs: each person's pay, or the payments made
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

  // Kept to the CRMs picked (2026-11-27): what is still owed on their invoices, and the VAT on their sales — both are
  // invoices, and an invoice says which CRM it came through. Input VAT is from supplier bills, which say no CRM, so it
  // stays the organization's whole; and so do expenses, payables and the bank.
  const crms = filters.crm ? filters.crm.split("\u001f") : [];
  let owed = { asOf: receivables.asOf, ...receivables.totals };
  let outputVat = vat.outputTaxMinor;
  if (crms.length) {
    const [aged, sales] = await Promise.all([
      agingReportForPortal({ org: org.id, kind: "receivables", crm: crms, limit: "0" }),
      vatReportForPortal({ org: org.id, from: period.from, to: period.to, kind: "output", crm: crms, limit: "0" }),
    ]);
    if (typeof aged !== "string") {
      const band = (k: string) => aged.groups.find((g: any) => g.key === k)?.amountMinor ?? 0;
      owed = { ...owed, current: band("current"), band1to30: band("band1to30"), band31to60: band("band31to60"), band61to90: band("band61to90"), band90plus: band("band90plus"), grand: aged.totals.amountMinor };
    }
    if (typeof sales !== "string") outputVat = Number((sales.totals as Record<string, number>).amountMinor) || 0;
  }

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
    receivables: owed,
    payables: { asOf: payables.asOf, ...payables.totals },
    vat: { outputMinor: outputVat, inputMinor: vat.inputTaxMinor, netPayableMinor: outputVat - vat.inputTaxMinor, ...(crms.length ? { outputByCrm: true } : {}) },
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

  // ?paidIn=INR (2026-11-27: "Collections in INR is not clickable"): only the payments made in that currency — the ones
  // the Collected report keeps apart from its own and only totals — as paid, with their own totals, groups and days.
  const paidIn = basis === "collected" ? str(q.paidIn).toUpperCase() : "";
  if (paidIn) {
    const line = report.foreign?.lines.find((l) => l.currency === paidIn);
    const away = (report.foreign?.records ?? []).filter((r) => String(r.currency).toUpperCase() === paidIn);
    const rows = rowsOf(report, REVENUE_ROW_DIMENSIONS).filter((r) => String(r.currency ?? "").toUpperCase() === paidIn);
    const by = new Map<string, Day>();
    for (const r of away) { const d = by.get(r.date) ?? by.set(r.date, { day: r.date, amountMinor: 0, count: 0 }).get(r.date)!; d.amountMinor += r.amountMinor; d.count++; }
    const { customer: _c, ...opts } = report.options;
    return {
      generatedAt: new Date().toISOString(), org, period, basis, groupBy: wanted, currency: paidIn, paidIn,
      totals: { amountMinor: line?.amountMinor ?? 0, count: line?.count ?? 0, collectedMinor: line?.amountMinor ?? 0, recordedMinor: line?.recordedMinor ?? 0 },
      groups: byDay ? [] : report.groups.flatMap((g) => { const f = g.foreign?.find((x) => x.currency === paidIn); return f ? [{ key: g.key, name: g.name, count: f.count, amountMinor: f.amountMinor }] : []; }),
      months: [],
      days: report.capped || away.length < (line?.count ?? 0) ? null : [...by.values()].sort((a, b) => a.day.localeCompare(b.day)),
      options: opts,
      ...pageOf(rows, q, REVENUE_ROW_DIMENSIONS),
      recordCount: line?.count ?? 0,
      capped: report.capped,
      foreign: null,
    };
  }
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
      Invoice.find({ _id: { $in: every.map((r) => new Types.ObjectId(String(r.id))) } }).select("salespersonId salespersonName enrolment.crm external.source").lean<any[]>(),
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
      // Which CRM the invoice came through (2026-11-27: "why … receivables … still same when crm is switched"): its
      // key is what is filtered on — the same keys the Revenue report's CRM filter takes — and its name is shown.
      const c = crmOf(i ?? {});
      r.crmKey = c.key;
      r.crm = CRM_NAMES[c.key] ?? c.name;
    }
  }

  // What each filter can be set to, counted before any of them is applied, so a list always offers what there is.
  const FILTERS = kind === "receivables" ? (["crm", "party", "band", "salesperson", "department"] as const) : (["party", "band"] as const);
  // The CRM is filtered by its key and shown by its name; everything else is its own name.
  const field = (f: string) => (f === "party" ? "title" : f === "crm" ? "crmKey" : f);
  const label = (f: string, r: Row) => String((f === "crm" ? r.crm : r[field(f)]) ?? "");
  const options: Record<string, { key: string; name: string; count: number }[]> = {};
  for (const f of FILTERS) {
    const counts = new Map<string, { name: string; n: number }>();
    for (const r of every) { const k = String(r[field(f)] ?? ""); counts.set(k, { name: label(f, r), n: (counts.get(k)?.n ?? 0) + 1 }); }
    options[f] = [...counts.entries()].map(([key, { name, n }]) => ({ key, name: name || "—", count: n }))
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
    ...pageOf(rows, { sort: "dueDate", dir: "asc", ...q }, ["dueDate", "daysOverdue", "totalMinor", "salesperson", "department", "crm"]),
    recordCount: rows.length,
    capped: false,
    otherCurrencies: report.otherCurrencies ?? [],
  };
}

/*
 * Commission and payroll for Root (the user, 2026-11-27: "do next Commission and payroll").
 *
 * Both are lists of rows that finance already keeps — the commission payouts it approved and paid, and the lines and
 * payments of its payroll runs — so both go through one helper: keep the rows the filters and the search keep, total
 * and group the ones in the organization's own currency, and give the rest apart, a line per currency, never added
 * in. Every filter takes several values; its choices are counted before any filter is applied.
 */
type Sums = Record<string, number>;

function ledger(all: Row[], q: Record<string, unknown>, org: Org, cfg: { filters: readonly string[]; sums: readonly string[]; groups: readonly string[]; groupBy: string; sort: readonly string[]; text: (r: Row) => string; named?: Record<string, string> }) {
  // A field filtered by its key and shown by another (the CRM: "draw" shown as "Draw").
  const nameOf = (f: string, r: Row) => String((cfg.named?.[f] ? r[cfg.named[f]!] : r[f]) ?? "");
  const options: Record<string, { key: string; name: string; count: number }[]> = {};
  for (const f of cfg.filters) {
    const counts = new Map<string, { name: string; n: number }>();
    for (const r of all) { const k = String(r[f] ?? ""); counts.set(k, { name: nameOf(f, r), n: (counts.get(k)?.n ?? 0) + 1 }); }
    options[f] = [...counts.entries()].map(([key, { name, n }]) => ({ key, name: name || "—", count: n })).sort((a, b) => (f === "month" ? b.key.localeCompare(a.key) : a.name.localeCompare(b.name)));
  }
  const asked = (f: string): string[] => (Array.isArray(q[f]) ? (q[f] as unknown[]) : [q[f]]).filter((x): x is string => typeof x === "string" && x !== "").slice(0, 50);
  const needle = str(q.q).slice(0, 100).toLowerCase();
  const kept = all.filter((r) => cfg.filters.every((f) => { const want = asked(f); return !want.length || want.includes(String(r[f] ?? "")); }) && (!needle || cfg.text(r).toLowerCase().includes(needle)));
  const total = (list: Row[]): Sums => Object.fromEntries(cfg.sums.map((k) => [k, list.reduce((n, r) => n + (Number(r[k]) || 0), 0)]));
  const own = kept.filter((r) => r.currency === org.currency);
  const groupBy = cfg.groups.includes(cfg.groupBy) ? cfg.groupBy : cfg.groups[0]!;
  const by = new Map<string, Row[]>();
  for (const r of own) { const k = String(r[groupBy] ?? "") || "—"; by.set(k, [...(by.get(k) ?? []), r]); }
  const groups = [...by.entries()].map(([key, list]) => ({ key, name: nameOf(groupBy, list[0]!) || key, count: list.length, ...total(list) }))
    .sort((a, b) => (groupBy === "month" ? b.key.localeCompare(a.key) : (Number((b as unknown as Sums).amountMinor) || 0) - (Number((a as unknown as Sums).amountMinor) || 0) || a.name.localeCompare(b.name)));
  const otherCurrencies = [...new Set(kept.map((r) => String(r.currency)).filter((c) => c !== org.currency))].sort().map((currency) => {
    const list = kept.filter((r) => r.currency === currency);
    return { currency, count: list.length, ...total(list) };
  });
  return { groupBy, currency: org.currency, totals: { count: own.length, ...total(own) }, groups, options, otherCurrencies, ...pageOf(kept, q, cfg.sort), recordCount: kept.length, capped: false };
}

/** "2026-11" of a day, and whether a month is within a period's months. */
const monthOf = (day: string) => day.slice(0, 7);
const titled = (v: unknown) => String(v ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/**
 * Commission finance has approved, and paid: the sales CRMs' monthly payouts and CS Portal's bonus and deposit
 * payouts — one row per person per period, with who approved it and, once paid, when, how and under which expense.
 *
 * By the month the commission is for (default), or with ?when=paid by the day it was paid. What the CRMs worked out
 * before approval — estimated, waiting for full payment — is not here: finance has no record of it.
 */
export async function commissionReportForPortal(q: Record<string, unknown>) {
  const org = await organizationOf(q);
  if (typeof org === "string") return org;
  const period = periodOf(q);
  if (typeof period === "string") return period;
  const paid = str(q.when) === "paid";
  const orgId = new Types.ObjectId(org.id);
  const months = { $gte: monthOf(period.from), $lte: monthOf(period.to) };
  const days = { $gte: utc(period.from), $lte: new Date(`${period.to}T23:59:59.999Z`) };
  const [crm, cs] = await Promise.all([
    CrmCommissionPayout.find({ organizationId: orgId, ...(paid ? { state: "paid", paidOn: days } : { month: months }) }).lean<any[]>(),
    CsCommissionPayout.find({ organizationId: orgId, ...(paid ? { state: "paid", paidOn: days } : { lastMonth: months }) }).lean<any[]>(),
  ]);
  const row = (p: any, source: string, kind: string, month: string, detail: string): Row => ({
    id: String(p._id), date: iso(new Date(p.paidOn ?? p.approvedAt)), number: p.expenseNumber || "", title: p.personName || "—", detail,
    person: p.personName || "—", source, kind, month, state: p.state === "paid" ? "Paid" : "Approved, not paid",
    method: p.paymentMethod ? titled(p.paymentMethod) : "", reference: p.reference || "", approvedBy: p.approvedByName || "",
    approvedOn: iso(new Date(p.approvedAt)), paidOn: p.paidOn ? iso(new Date(p.paidOn)) : "", payrollRun: p.payrollRunNumber || "",
    currency: String(p.currency || org.currency).toUpperCase(), amountMinor: p.amountMinor ?? 0,
    paidMinor: p.state === "paid" ? p.amountMinor ?? 0 : 0, unpaidMinor: p.state === "paid" ? 0 : p.amountMinor ?? 0,
    href: p.expenseId ? `/expenses/${p.expenseId}` : "",
  });
  const rows = [
    ...crm.map((p) => row(p, p.crmName || titled(p.crm), "CRM commission", p.month, [(p.roles ?? []).join(", "), p.level].filter(Boolean).join(" · "))),
    ...cs.map((p) => row(p, "CS Portal", p.kind === "deposit" ? "CS deposit commission" : "CS bonus commission", p.lastMonth, `${p.period}${p.location === "bangalore" ? " · Bangalore" : ""}`)),
  ];
  return {
    generatedAt: new Date().toISOString(), org, period, when: paid ? "paid" : "month",
    ...ledger(rows, { sort: "date", dir: "desc", ...q }, org, {
      filters: ["source", "person", "state", "kind", "method", "month"], sums: ["amountMinor", "paidMinor", "unpaidMinor"],
      groups: ["person", "source", "month", "state", "kind"], groupBy: str(q.groupBy) || "person",
      sort: ["person", "source", "month", "state", "method", "approvedOn", "paidOn"], text: (r) => `${r.title} ${r.number} ${r.reference} ${r.source}`,
    }),
  };
}

const LINE_STATUS: Record<string, string> = { pending: "Not paid", on_hold: "On hold", partially_paid: "Part paid", paid: "Paid" };
/** Where the run itself stands: a run finance has not approved yet is still being put together, and says so. */
const RUN_STATE: Record<string, string> = { imported: "Not approved yet", additions: "Not approved yet", approved: "Approved", partially_paid: "Part paid", paid: "Paid" };

/**
 * Payroll for Root: the runs of the period's months (voided and returned ones left out). ?kind=people (default) is a
 * row per person per run — gross, deductions, net as the HRMS worked it out, finance's additions and deductions, what
 * is payable, what has been paid and what is left; ?kind=payments is a row per payment made, reversed ones left out.
 * ?due=1 keeps the people still owed something.
 *
 * Nobody's bank details are read, let alone sent: the lines are selected without them.
 */
export async function payrollReportForPortal(q: Record<string, unknown>) {
  const org = await organizationOf(q);
  if (typeof org === "string") return org;
  const period = periodOf(q);
  if (typeof period === "string") return period;
  const kind = str(q.kind) || "people";
  if (kind !== "people" && kind !== "payments") return "kind is people or payments";
  const runs = await PayrollRun.find({ organizationId: new Types.ObjectId(org.id), period: { $gte: monthOf(period.from), $lte: monthOf(period.to) }, status: { $nin: ["voided", "returned"] } })
    .select("runNumber period currency status lines._id lines.name lines.designation lines.departmentName lines.currency lines.grossMinor lines.deductionsMinor lines.netFromHrmsMinor lines.adjustmentsMinor lines.payableMinor lines.amountPaidMinor lines.status payments._id payments.method payments.paidOn payments.reference payments.bankAccountName payments.currency payments.amountMinor payments.reversedAt payments.createdByName")
    .lean<any[]>();
  const cur = (v: unknown, run: any) => String(v || run.currency || org.currency).toUpperCase();
  if (kind === "payments") {
    const rows: Row[] = runs.flatMap((run) => (run.payments ?? []).filter((p: any) => !p.reversedAt).map((p: any): Row => ({
      id: `${run._id}:${p._id}`, date: iso(new Date(p.paidOn)), number: run.runNumber, title: `Payroll ${run.period}`, detail: p.reference || "",
      run: run.runNumber, month: run.period, method: titled(p.method), bank: p.bankAccountName || "No bank account", reference: p.reference || "", paidBy: p.createdByName || "",
      currency: cur(p.currency, run), amountMinor: p.amountMinor ?? 0, href: `/payroll/${run._id}`,
    })));
    return {
      generatedAt: new Date().toISOString(), org, period, kind,
      ...ledger(rows, { sort: "date", dir: "desc", ...q }, org, {
        filters: ["month", "method", "bank"], sums: ["amountMinor"], groups: ["month", "method", "bank"], groupBy: str(q.groupBy) || "month",
        sort: ["run", "month", "method", "bank"], text: (r) => `${r.number} ${r.reference} ${r.bank}`,
      }),
    };
  }
  const due = ["1", "true"].includes(str(q.due));
  const rows: Row[] = runs.flatMap((run) => (run.lines ?? []).map((l: any): Row => ({
    id: `${run._id}:${l._id}`, date: `${run.period}-01`, number: run.runNumber, title: l.name || "—", detail: l.designation || "",
    person: l.name || "—", department: l.departmentName || "No department", month: run.period, run: run.runNumber, status: LINE_STATUS[l.status] ?? titled(l.status), runState: RUN_STATE[run.status] ?? titled(run.status),
    currency: cur(l.currency, run), grossMinor: l.grossMinor ?? 0, deductionsMinor: l.deductionsMinor ?? 0, netMinor: l.netFromHrmsMinor ?? 0,
    adjustmentsMinor: l.adjustmentsMinor ?? 0, amountMinor: l.payableMinor ?? 0, paidMinor: l.amountPaidMinor ?? 0,
    balanceMinor: Math.max(0, (l.payableMinor ?? 0) - (l.amountPaidMinor ?? 0)), href: `/payroll/${run._id}`,
  }))).filter((r) => !due || Number(r.balanceMinor) > 0);
  return {
    generatedAt: new Date().toISOString(), org, period, kind, due,
    ...ledger(rows, { sort: "title", dir: "asc", ...q }, org, {
      filters: ["month", "department", "person", "status", "runState"], sums: ["grossMinor", "deductionsMinor", "netMinor", "adjustmentsMinor", "amountMinor", "paidMinor", "balanceMinor"],
      groups: ["month", "department", "person", "status", "runState"], groupBy: str(q.groupBy) || "month",
      sort: ["person", "department", "month", "run", "status", "runState", "grossMinor", "deductionsMinor", "netMinor", "adjustmentsMinor", "paidMinor", "balanceMinor"], text: (r) => `${r.title} ${r.detail} ${r.number}`,
    }),
  };
}

const INVOICE_STATE: Record<string, string> = { sent: "Sent", viewed: "Sent", partial: "Part paid", paid: "Paid", overdue: "Overdue" };

/**
 * The rows behind two of the Report Org's headline cards (2026-11-27: "when click on the stats card we need to see
 * break down"), counted exactly as the card counts them:
 *
 *   kind=output — VAT on sales, as finance's VAT report counts it: each invoice issued in the period with its VAT,
 *                 and on a pro-forma each payment's tax invoice dated in the period, with that tax invoice's VAT.
 *   kind=input  — VAT on purchases: each supplier bill dated in the period with its VAT.
 *   kind=income — the income in "Income less expenses", as the Profit & Loss counts it: each invoice issued in the
 *                 period, before VAT (a pro-forma whole, by its own date, as the P&L has it).
 *
 * Drafts and void invoices or bills are left out. Totals are of the organization's currency; any other is apart.
 */
export async function vatReportForPortal(q: Record<string, unknown>) {
  const org = await organizationOf(q);
  if (typeof org === "string") return org;
  const period = periodOf(q);
  if (typeof period === "string") return period;
  const kind = str(q.kind) || "output";
  if (!["output", "input", "income"].includes(kind)) return "kind is output, input or income";
  const orgId = new Types.ObjectId(org.id);
  const range = { $gte: utc(period.from), $lte: new Date(`${period.to}T23:59:59.999Z`) };
  const cur = (v: unknown) => String(v || org.currency).toUpperCase();
  const crmName = (inv: any) => { const c = crmOf(inv); return CRM_NAMES[c.key] ?? c.name; };
  const done = (rows: Row[], filters: string[], sums: string[], groups: string[], sort: string[]) => ({
    generatedAt: new Date().toISOString(), org, period, kind,
    ...ledger(rows, { sort: "date", dir: "desc", ...q }, org, { filters, sums, groups, groupBy: str(q.groupBy) || groups[0]!, sort, text: (r) => `${r.number} ${r.title} ${r.detail}`, named: { crm: "crmName" } }),
  });

  if (kind === "input") {
    const bills = await Bill.find({ organizationId: orgId, billDate: range, status: { $nin: ["draft", "voided"] } })
      .select("billNumber vendorName billDate status currency subtotalMinor taxTotalMinor totalMinor").lean<any[]>();
    const rows: Row[] = bills.map((b) => ({
      id: String(b._id), date: iso(new Date(b.billDate)), number: b.billNumber, title: b.vendorName || "—", detail: "",
      vendor: b.vendorName || "—", month: iso(new Date(b.billDate)).slice(0, 7), status: titled(b.status),
      currency: cur(b.currency), amountMinor: b.taxTotalMinor ?? 0, netMinor: b.subtotalMinor ?? 0, totalMinor: b.totalMinor ?? 0, href: `/bills/${b._id}`,
    }));
    return done(rows, ["vendor", "month", "status"], ["amountMinor", "netMinor", "totalMinor"], ["month", "vendor", "status"], ["vendor", "month", "status", "netMinor", "totalMinor"]);
  }

  const SELECT = "invoiceNumber customerName salespersonName issueDate status currency subtotalMinor taxTotalMinor totalMinor enrolment.crm external.source proforma taxBreakdown payments._id payments.paidOn payments.amountMinor payments.taxInvoice";
  const invoiceRow = (inv: any, amount: number): Row => ({
    id: String(inv._id), date: iso(new Date(inv.issueDate)), number: inv.invoiceNumber, title: inv.customerName || "—", detail: inv.salespersonName || "",
    salesperson: inv.salespersonName || "No salesperson", crm: crmOf(inv).key, crmName: crmName(inv), month: iso(new Date(inv.issueDate)).slice(0, 7), status: INVOICE_STATE[inv.status] ?? titled(inv.status),
    currency: cur(inv.currency), amountMinor: amount, netMinor: inv.subtotalMinor ?? 0, vatMinor: inv.taxTotalMinor ?? 0, totalMinor: inv.totalMinor ?? 0, href: `/invoices/${inv._id}`,
  });

  if (kind === "income") {
    const invoices = await Invoice.find({ organizationId: orgId, issueDate: range, status: { $nin: ["draft", "void"] } }).select(SELECT).lean<any[]>();
    const rows = invoices.map((inv) => invoiceRow(inv, inv.subtotalMinor ?? 0));
    return done(rows, ["crm", "salesperson", "month", "status"], ["amountMinor", "vatMinor", "totalMinor"], ["month", "crm", "salesperson", "status"], ["title", "crm", "salesperson", "month", "status", "vatMinor", "totalMinor"]);
  }

  // Output VAT, as finance's VAT report: ordinary invoices by issue date; a pro-forma's tax invoices by the day paid.
  const [invoices, proformas] = await Promise.all([
    Invoice.find({ organizationId: orgId, issueDate: range, status: { $nin: ["draft", "void"] }, "proforma.at": { $exists: false } }).select(SELECT).lean<any[]>(),
    Invoice.find({ organizationId: orgId, status: { $nin: ["draft", "void"] }, "proforma.at": { $exists: true }, payments: { $elemMatch: { paidOn: range, "taxInvoice.number": { $exists: true } } } }).select(SELECT).lean<any[]>(),
  ]);
  const rows: Row[] = invoices.map((inv) => invoiceRow(inv, inv.taxTotalMinor ?? 0));
  const lo = range.$gte.getTime(), hi = range.$lte.getTime();
  for (const inv of proformas) {
    for (const p of inv.payments ?? []) {
      const at = new Date(p.paidOn).getTime();
      if (!p.taxInvoice?.number || at < lo || at > hi) continue;
      const vat = p.taxInvoice.taxMinor ?? 0;
      const day = iso(new Date(p.paidOn));
      rows.push({
        ...invoiceRow(inv, vat), id: `${inv._id}:${p._id}`, date: day, month: day.slice(0, 7), number: p.taxInvoice.number,
        detail: [`Payment towards ${inv.invoiceNumber}`, inv.salespersonName].filter(Boolean).join(" · "),
        netMinor: (p.amountMinor ?? 0) - vat, totalMinor: p.amountMinor ?? 0,
      });
    }
  }
  return done(rows, ["crm", "salesperson", "month", "status"], ["amountMinor", "netMinor", "totalMinor"], ["month", "crm", "salesperson", "status"], ["title", "crm", "salesperson", "month", "status", "netMinor", "totalMinor"]);
}
