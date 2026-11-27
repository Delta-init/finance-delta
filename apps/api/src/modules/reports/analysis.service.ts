import { Types } from "mongoose";
import {
  ACADEMIES,
  ENROLMENT_CRM_LABELS,
  OLD_BOOKS_SOURCE,
  PAYMENT_METHOD_LABELS,
  categoryLabel,
  enrolmentCrm,
  paidAmountMinor,
  paidCurrency,
  type AnalysisForeign,
  type AnalysisGroup,
  type AnalysisOption,
  type AnalysisRecord,
  type AnalysisReport,
  type ExpenseDimension,
  type PaymentMethod,
  type RevenueDimension,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { Expense } from "../expense/expense.model";
import { Invoice } from "../invoice/invoice.model";
import { CreditNote } from "../credit-note/credit-note.model";
import { BankAccount } from "../banking/bank-account.model";
import { Department } from "../department/department.model";
import { User } from "../user/user.model";
import { Organization } from "../organization/organization.model";
import { categoryNameMap, pnlExpenseFilter } from "../expense-category/expense-category.service";

/*
 * The Expense and Revenue reports (the user, 2026-10-24: "a report on expenses and revenue — all expenses, by
 * category, employee-wise and department-wise, with more filters; and the same for revenue").
 *
 * Each record is read once with its key in every dimension; the filters keep the records whose key matches, and the
 * report groups what is left by the dimension asked for. The options (every value of every dimension, with its name)
 * come from the period before the filters, so a dropdown always offers what the period has.
 *
 * Expenses: approved and waiting for approval (as the Daily Report and the P&L count them), dated by the expense date
 * or the paid date. A bill's expense is here too ("Supplier bill" under Source). "P&L only" leaves out what the
 * categories say isn't an expense (advances, payroll clearing, VAT, loan principal).
 *
 * Revenue: invoices issued (not drafts, not void), less the credit notes issued against them in the period — or the
 * payments collected in the period. In the organization's currency.
 */

const MAX_RECORDS = 5000;
const NONE = "__none";

function oid(id: string) {
  return new Types.ObjectId(id);
}
const dayOf = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
const startOf = (day: string) => new Date(`${day}T00:00:00.000Z`);
const endOf = (day: string) => new Date(`${day}T23:59:59.999Z`);
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const methodName = (m: string) => PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? m.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** A dimension's values while the records are read: key → name. */
class Names {
  private m = new Map<string, Map<string, string>>();
  set(dim: string, key: string, name: string): string {
    const d = this.m.get(dim) ?? new Map<string, string>();
    if (!d.has(key)) d.set(key, name);
    this.m.set(dim, d);
    return key;
  }
  name(dim: string, key: string): string {
    return this.m.get(dim)?.get(key) ?? key;
  }
}

/** What a report takes besides its period: the dimension to group by, and a key for any dimension to keep. */
export interface AnalysisQuery {
  from: string;
  to: string;
  basis: string;
  groupBy: string;
  filters: Record<string, string>;
  pnlOnly?: boolean;
  search?: string;
  /** Which currency's figures to give (2026-11-07); blank: the organization's. */
  currency?: string;
}

/** The currencies among some rows, the organization's first, then the most used. */
export function currenciesOf<T>(rows: T[], curOf: (r: T) => string, base: string): string[] {
  const n = new Map<string, number>();
  for (const r of rows) n.set(curOf(r), (n.get(curOf(r)) ?? 0) + 1);
  return [...n.keys()].sort((a, b) => (a === base ? -1 : b === base ? 1 : (n.get(b)! - n.get(a)!) || a.localeCompare(b)));
}

/** The one asked for if there is some of it, else the organization's, else the first there is. */
export function pickCurrency(currencies: string[], want: string | undefined, base: string): string {
  const w = (want ?? "").toUpperCase();
  return currencies.includes(w) ? w : currencies.includes(base) ? base : currencies[0] ?? base;
}

function finish(
  kind: AnalysisReport["kind"],
  q: AnalysisQuery,
  currency: string,
  all: AnalysisRecord[],
  names: Names,
  dimensions: readonly string[],
  extraTotals: (kept: AnalysisRecord[]) => Partial<AnalysisReport["totals"]>,
): AnalysisReport {
  // The options: every value in the period, before the filters.
  const options: Record<string, AnalysisOption[]> = {};
  for (const dim of dimensions) {
    const counts = new Map<string, number>();
    for (const r of all) counts.set(r.dims[dim] ?? NONE, (counts.get(r.dims[dim] ?? NONE) ?? 0) + 1);
    options[dim] = [...counts.entries()]
      .map(([key, count]) => ({ key, name: names.name(dim, key), count }))
      .sort((a, b) => (dim === "month" ? b.key.localeCompare(a.key) : a.name.localeCompare(b.name)));
  }

  const needle = (q.search ?? "").trim().toLowerCase();
  const kept = all.filter((r) => {
    for (const [dim, key] of Object.entries(q.filters)) if (!keeps1(key, r.dims[dim] ?? NONE)) return false;
    return !needle || `${r.number} ${r.title} ${r.detail}`.toLowerCase().includes(needle);
  });

  const group = (rows: AnalysisRecord[], dim: string): AnalysisGroup[] => {
    const by = new Map<string, AnalysisGroup>();
    for (const r of rows) {
      const key = r.dims[dim] ?? NONE;
      const g = by.get(key) ?? { key, name: names.name(dim, key), count: 0, amountMinor: 0 };
      g.count++;
      g.amountMinor += r.amountMinor;
      if (r.collectedMinor !== undefined) g.collectedMinor = (g.collectedMinor ?? 0) + r.collectedMinor;
      if (r.owedMinor !== undefined) g.owedMinor = (g.owedMinor ?? 0) + r.owedMinor;
      by.set(key, g);
    }
    return [...by.values()].sort((a, b) => (dim === "month" ? b.key.localeCompare(a.key) : b.amountMinor - a.amountMinor || a.name.localeCompare(b.name)));
  };
  // Never two currencies added together (the user, 2026-11-07: an INR 50,000 expense counted as AED 50,000): every
  // currency's totals for the cards; the rest is one currency's — the one asked for, else the organization's.
  const curOf = (r: AnalysisRecord) => (r.currency || currency).toUpperCase();
  const currencies = currenciesOf(kept, curOf, currency);
  const chosen = pickCurrency(currencies, q.currency, currency);
  const byCurrency = currencies.map((c) => {
    const rows = kept.filter((r) => curOf(r) === c);
    return { currency: c, amountMinor: rows.reduce((s, r) => s + r.amountMinor, 0), count: rows.length, ...extraTotals(rows) };
  });
  const shown = kept.filter((r) => curOf(r) === chosen);

  const groups = group(shown, q.groupBy);
  if (q.groupBy === "category") {
    for (const g of groups) g.sub = group(shown.filter((r) => (r.dims.category ?? NONE) === g.key), "subcategory");
  }
  const months = group(shown, "month").map((g) => ({ month: g.key, amountMinor: g.amountMinor, count: g.count })).sort((a, b) => a.month.localeCompare(b.month));

  shown.sort((a, b) => b.date.localeCompare(a.date) || b.amountMinor - a.amountMinor);
  return {
    kind, from: q.from, to: q.to, currency: chosen, basis: q.basis, groupBy: q.groupBy,
    totals: { amountMinor: shown.reduce((s, r) => s + r.amountMinor, 0), count: shown.length, ...extraTotals(shown) },
    groups, months, options,
    records: shown.slice(0, MAX_RECORDS),
    capped: shown.length > MAX_RECORDS,
    currencies, byCurrency,
  };
}

async function orgCurrency(orgId: string): Promise<string> {
  const org = await Organization.findById(orgId).select("baseCurrency").lean<{ baseCurrency?: string }>();
  return org?.baseCurrency ?? "AED";
}

async function departmentNames(orgId: string): Promise<Map<string, string>> {
  const rows = await Department.find({ organizationId: oid(orgId) }).select("name").lean<{ _id: Types.ObjectId; name: string }[]>();
  return new Map(rows.map((d) => [String(d._id), d.name]));
}

async function bankNames(orgId: string): Promise<Map<string, string>> {
  const rows = await BankAccount.find({ organizationId: oid(orgId) }).select("accountName").lean<{ _id: Types.ObjectId; accountName: string }[]>();
  return new Map(rows.map((b) => [String(b._id), b.accountName]));
}

const EXPENSE_SOURCE: Record<string, string> = {
  bill: "Supplier bill", hrms_procurement: "HRMS purchase", hrms_advance: "HRMS salary advance", hrms_one_time: "HRMS one-time payment", hrms_reimbursement: "HRMS reimbursement", import: "Old books (imported)",
};

export async function getExpenseAnalysis(orgId: string, q: AnalysisQuery): Promise<AnalysisReport> {
  if (q.basis !== "expense" && q.basis !== "paid") throw new AppError("VALIDATION_ERROR", "basis must be expense or paid");
  const dateField = q.basis === "paid" ? "paidOn" : "expenseDate";
  const [currency, nameMap, depts, banks, pnl] = await Promise.all([
    orgCurrency(orgId), categoryNameMap(orgId), departmentNames(orgId), bankNames(orgId), q.pnlOnly ? pnlExpenseFilter(orgId) : Promise.resolve({}),
  ]);
  const expenses = await Expense.find({
    organizationId: oid(orgId),
    status: { $in: ["approved", "submitted"] },
    [dateField]: { ...(q.from ? { $gte: startOf(q.from) } : { $ne: null }), ...(q.to ? { $lte: endOf(q.to) } : {}) },
    ...pnl,
  })
    .select("expenseNumber category categoryName subcategory subcategoryName description expenseDate paidOn totalMinor currency submittedById submittedByName salespersonId salespersonName departmentId paymentMethod bankAccountId paymentAccount source status")
    .lean();

  const names = new Names();
  const records: AnalysisRecord[] = (expenses as any[]).map((e) => {
    const date = dayOf(e[dateField] ?? e.expenseDate);
    const cat = String(e.category ?? NONE);
    const catName = nameMap.get(cat) ?? e.categoryName ?? cat;
    const sub = e.subcategory ? `${cat}/${e.subcategory}` : `${cat}/${NONE}`;
    const submitter = e.submittedById ? String(e.submittedById) : `name:${e.submittedByName ?? ""}`;
    const employee = e.salespersonId ? String(e.salespersonId) : submitter;
    // An account named only in words (older expenses) counts by that name.
    const typed = String(e.paymentAccount ?? "").trim();
    const bank = e.bankAccountId ? String(e.bankAccountId) : typed ? `name:${typed.toLowerCase()}` : NONE;
    const sourceKind = String(e.source?.kind ?? NONE);
    const dept = e.departmentId ? String(e.departmentId) : NONE;
    return {
      id: String(e._id), date, number: e.expenseNumber, title: categoryLabel(catName, e.subcategoryName) || "Expense", detail: e.description ?? "",
      amountMinor: e.totalMinor ?? 0, currency: String(e.currency || currency).toUpperCase(), href: `/expenses/${e._id}`,
      dims: {
        category: names.set("category", cat, catName || "Uncategorised"),
        subcategory: names.set("subcategory", sub, e.subcategory ? (e.subcategoryName || e.subcategory) : `${catName} — no subcategory`),
        employee: names.set("employee", employee, (e.salespersonId ? e.salespersonName : e.submittedByName) || "—"),
        submittedBy: names.set("submittedBy", submitter, e.submittedByName || "—"),
        department: names.set("department", dept, dept === NONE ? "No department" : depts.get(dept) ?? "A removed department"),
        method: names.set("method", e.paymentMethod ?? NONE, e.paymentMethod ? methodName(e.paymentMethod) : "Not said"),
        bank: names.set("bank", bank, bank === NONE ? "No bank account" : bank.startsWith("name:") ? typed : banks.get(bank) ?? (typed || "A removed account")),
        source: names.set("source", sourceKind, EXPENSE_SOURCE[sourceKind] ?? "Typed in finance"),
        status: names.set("status", e.status, e.status === "approved" ? "Approved" : "Waiting for approval"),
        paid: names.set("paid", e.paidOn ? "paid" : "unpaid", e.paidOn ? "Paid" : "Not paid yet"),
        month: names.set("month", date.slice(0, 7), monthName(date.slice(0, 7))),
      },
    };
  });

  return finish("expense", q, currency, records, names, EXPENSE_DIMENSION_KEYS, (kept) => {
    const paid = kept.filter((r) => r.dims.paid === "paid").reduce((s, r) => s + r.amountMinor, 0);
    return { paidMinor: paid, unpaidMinor: kept.reduce((s, r) => s + r.amountMinor, 0) - paid };
  });
}
const EXPENSE_DIMENSION_KEYS: readonly ExpenseDimension[] = ["category", "subcategory", "employee", "submittedBy", "department", "method", "bank", "source", "status", "paid", "month"];

const REVENUE_DIMENSION_KEYS: readonly RevenueDimension[] = ["salesperson", "department", "course", "customer", "crm", "academy", "method", "bank", "status", "month"];
const INVOICE_STATUS: Record<string, string> = { paid: "Paid", partial: "Part paid", sent: "Not paid", viewed: "Not paid", overdue: "Overdue" };

/** Which CRM an invoice came from — or typed in finance. */
export function crmOf(inv: any): { key: string; name: string } {
  const crm = enrolmentCrm(inv.enrolment?.crm, inv.external?.source);
  if (crm) return { key: crm, name: ENROLMENT_CRM_LABELS[crm] };
  if (inv.external?.source === OLD_BOOKS_SOURCE) return { key: "old_books", name: "Old books" };
  return inv.external?.source ? { key: String(inv.external.source), name: String(inv.external.source) } : { key: NONE, name: "Typed in finance" };
}

/** Each person's department in an organization, by user id. */
async function departmentsOfPeople(orgId: string): Promise<Map<string, string>> {
  const people = await User.find({ "memberships.organizationId": oid(orgId) }).select("memberships").lean<any[]>();
  const deptOf = new Map<string, string>();
  for (const u of people) {
    const m = (u.memberships ?? []).find((x: any) => String(x.organizationId) === orgId);
    if (m?.departmentId) deptOf.set(String(u._id), String(m.departmentId));
  }
  return deptOf;
}

export async function getRevenueAnalysis(orgId: string, q: AnalysisQuery, viewer?: { userId: string; isSuperAdmin?: boolean }): Promise<AnalysisReport> {
  if (q.basis !== "invoiced" && q.basis !== "collected") throw new AppError("VALIDATION_ERROR", "basis must be invoiced or collected");
  const [currency, depts, deptOf] = await Promise.all([orgCurrency(orgId), departmentNames(orgId), departmentsOfPeople(orgId)]);
  const names = new Names();
  const { records, extraTotals } = await revenueRecords(orgId, q, names, deptOf, depts, currency);
  // Collected: money paid in another currency than its invoice's is not this currency's — it is left out of the report
  // and shown beside it, as paid (withOtherCurrencies).
  const away = records.filter((r) => r.recordedMinor !== undefined);
  const own = away.length ? records.filter((r) => r.recordedMinor === undefined) : records;
  const report = finish("revenue", q, currency, own, names, REVENUE_DIMENSION_KEYS, extraTotals);
  withOtherCurrencies(report, own, away, q, names);
  if (viewer) await withOtherOrganization(report, orgId, currency, q, names, deptOf, depts, viewer);
  return report;
}

/** Whether a record passes the report's filters and search — as `finish` keeps them. */
function keeps(q: AnalysisQuery): (r: AnalysisRecord) => boolean {
  const needle = (q.search ?? "").trim().toLowerCase();
  return (r) => Object.entries(q.filters).every(([dim, key]) => keeps1(key, r.dims[dim] ?? NONE))
    && (!needle || `${r.number} ${r.title} ${r.detail}`.toLowerCase().includes(needle));
}

/**
 * Money paid in other currencies beside the Collected report (the user, 2026-11-26: "show INR collected as separate
 * instead of summing AED, same as the payment page"): a payment in rupees on an AED invoice was counted at what it was
 * recorded as, inside Collected. It is now left out of the totals, groups and records, and given as it was paid — on
 * each group (`foreign`) and on the report (`report.foreign`), a line per currency, never converted, with what those
 * payments were recorded as. One whose amount in that currency was never recorded stays in Collected, and its
 * currency's line says how many — as the Payments list's cards and the Daily Report do. The same filters, search and
 * grouping; their values are in the filter lists too, so an "INR Transfer" with nothing in dirhams can still be picked.
 */
function withOtherCurrencies(report: AnalysisReport, own: AnalysisRecord[], away: AnalysisRecord[], q: AnalysisQuery, names: Names): void {
  for (const dim of away.length ? REVENUE_DIMENSION_KEYS : []) {
    const opts = (report.options[dim] ??= []);
    const byKey = new Map(opts.map((o) => [o.key, o]));
    for (const r of away) {
      const key = r.dims[dim] ?? NONE;
      const o = byKey.get(key);
      if (o) { o.count++; continue; }
      const made = { key, name: names.name(dim, key), count: 1 };
      opts.push(made);
      byKey.set(key, made);
    }
    opts.sort((a, b) => (dim === "month" ? b.key.localeCompare(a.key) : a.name.localeCompare(b.name)));
  }

  const keep = keeps(q);
  const kept = away.filter(keep);
  type Line = NonNullable<AnalysisReport["foreign"]>["lines"][number];
  const lines = new Map<string, Line>();
  const lineOf = (currency: string): Line => {
    const l = lines.get(currency) ?? { currency, amountMinor: 0, count: 0, recordedMinor: 0, unknownCount: 0, unknownMinor: 0 };
    lines.set(currency, l);
    return l;
  };
  const byGroup = new Map<string, Map<string, AnalysisForeign>>();
  for (const r of kept) {
    const cur = String(r.currency).toUpperCase();
    const l = lineOf(cur);
    l.amountMinor += r.amountMinor;
    l.recordedMinor += r.recordedMinor ?? 0;
    l.count++;
    const key = r.dims[q.groupBy] ?? NONE;
    const g = byGroup.get(key) ?? new Map<string, AnalysisForeign>();
    const t = g.get(cur) ?? { currency: cur, amountMinor: 0, count: 0 };
    t.amountMinor += r.amountMinor;
    t.count++;
    g.set(cur, t);
    byGroup.set(key, g);
  }
  // Paid in another currency with no amount in it on record: still counted above, as recorded — said, not hidden.
  for (const r of own) {
    if (!r.paidIn || !keep(r)) continue;
    const l = lineOf(r.paidIn.toUpperCase());
    l.unknownCount++;
    l.unknownMinor += r.amountMinor;
  }
  if (!lines.size) return;

  const order = [...lines.values()].sort((a, b) => b.recordedMinor - a.recordedMinor || b.count - a.count || a.currency.localeCompare(b.currency));
  const rank = new Map(order.map((l, i) => [l.currency, i]));
  const listed = (g: Map<string, AnalysisForeign>) => [...g.values()].sort((a, b) => rank.get(a.currency)! - rank.get(b.currency)!);
  for (const g of report.groups) {
    const t = byGroup.get(g.key);
    if (t) { g.foreign = listed(t); byGroup.delete(g.key); }
  }
  // Keys with nothing in the report's currency: their own rows, after the others.
  const count = (g: Map<string, AnalysisForeign>) => [...g.values()].reduce((n, t) => n + t.count, 0);
  for (const [key, t] of [...byGroup.entries()].sort((a, b) => count(b[1]) - count(a[1]))) {
    report.groups.push({ key, name: names.name(q.groupBy, key), count: 0, amountMinor: 0, foreign: listed(t) });
  }
  kept.sort((a, b) => b.date.localeCompare(a.date) || (b.recordedMinor ?? 0) - (a.recordedMinor ?? 0));
  report.foreign = { lines: order, records: kept.slice(0, MAX_RECORDS) };
}

/**
 * The other organization's money beside the report (the user, 2026-11-25: "if Bangalore received the amount, also
 * show here and mention it's in Bangalore"): the organization keeping its books in another currency (Delta Banglore,
 * rupees, beside Delta International's dirhams) — read for the same period, filters, search and grouping; each person
 * is the same user in both, and their department is the one here. Its figures stay in its own currency, on the group
 * (`other`) and in the report (`report.other`), never added to this one's. Only for someone who is in that
 * organization too (or a super admin).
 */
async function withOtherOrganization(
  report: AnalysisReport, orgId: string, currency: string, q: AnalysisQuery, names: Names,
  deptOf: Map<string, string>, depts: Map<string, string>, viewer: { userId: string; isSuperAdmin?: boolean },
): Promise<void> {
  const others = await Organization.find({ _id: { $ne: oid(orgId) }, baseCurrency: { $nin: [currency, null, ""] } })
    .select("name baseCurrency").lean<{ _id: Types.ObjectId; name: string; baseCurrency: string }[]>();
  if (!others.length) return;
  const me = await User.findById(viewer.userId).select("memberships").lean<{ memberships?: { organizationId: unknown }[] } | null>();
  const mine = new Set((me?.memberships ?? []).map((m) => String(m.organizationId)));
  const other = others.find((o) => viewer.isSuperAdmin || mine.has(String(o._id)));
  if (!other) return;
  const otherId = String(other._id);
  const otherCurrency = String(other.baseCurrency).toUpperCase();
  // Everything it took, in its own currency as it recorded it — its payments are not split by currency here.
  const { records } = await revenueRecords(otherId, q, names, deptOf, depts);
  // Its values in the filter lists too (a person only in that organization), counted there, so they can be picked.
  for (const dim of REVENUE_DIMENSION_KEYS) {
    const opts = (report.options[dim] ??= []);
    const counts = new Map<string, number>();
    for (const r of records) counts.set(r.dims[dim] ?? NONE, (counts.get(r.dims[dim] ?? NONE) ?? 0) + 1);
    for (const [key, count] of counts) if (!opts.some((o) => o.key === key)) opts.push({ key, name: names.name(dim, key), count });
  }
  const needle = (q.search ?? "").trim().toLowerCase();
  const kept = records
    .filter((r) => Object.entries(q.filters).every(([dim, key]) => keeps1(key, r.dims[dim] ?? NONE)))
    .filter((r) => !needle || `${r.number} ${r.title} ${r.detail}`.toLowerCase().includes(needle))
    .map((r) => ({ ...r, currency: otherCurrency }));
  if (!kept.length) return;
  const byKey = new Map<string, { amountMinor: number; count: number }>();
  for (const r of kept) {
    const k = r.dims[q.groupBy] ?? NONE;
    const t = byKey.get(k) ?? { amountMinor: 0, count: 0 };
    t.amountMinor += r.amountMinor;
    t.count++;
    byKey.set(k, t);
  }
  for (const g of report.groups) {
    const t = byKey.get(g.key);
    if (t) { g.other = t; byKey.delete(g.key); }
  }
  // Keys only the other organization has: their own rows, after this one's.
  for (const [key, t] of [...byKey.entries()].sort((a, b) => b[1].amountMinor - a[1].amountMinor)) {
    report.groups.push({ key, name: names.name(q.groupBy, key), count: 0, amountMinor: 0, other: t });
  }
  kept.sort((a, b) => b.date.localeCompare(a.date) || b.amountMinor - a.amountMinor);
  report.other = {
    organizationId: otherId, organizationName: other.name, currency: otherCurrency,
    amountMinor: kept.reduce((s, r) => s + r.amountMinor, 0), count: kept.length, records: kept.slice(0, MAX_RECORDS),
  };
}

/**
 * One organization's revenue records for a query, named into `names`; departments as `deptOf` says (the report's).
 *
 * `apartFrom` (the report's own currency, given for the organization the report is about): under Collected, a payment
 * made in another currency than its invoice's comes as it was paid — `currency` and `amountMinor` in that currency,
 * `recordedMinor` what it was recorded as — and one whose amount in that currency was never recorded comes as
 * recorded, with `paidIn`. Without it every payment is what it was recorded as, as before.
 */
async function revenueRecords(orgId: string, q: AnalysisQuery, names: Names, deptOf: Map<string, string>, depts: Map<string, string>, apartFrom?: string) {
  const org = oid(orgId);
  const range = { ...(q.from ? { $gte: startOf(q.from) } : {}), ...(q.to ? { $lte: endOf(q.to) } : {}) };
  const ranged = Object.keys(range).length > 0;
  const inRange = (d: Date | string | undefined) => !!d && (!q.from || new Date(d) >= startOf(q.from)) && (!q.to || new Date(d) <= endOf(q.to));
  const banks = await bankNames(orgId);

  const SELECT = "invoiceNumber customerId customerName salespersonId salespersonName issueDate status currency totalMinor baseTotalMinor balanceMinor exchangeRate payments enrolment.course enrolment.crm enrolment.academy external.source lineItems.description proforma";
  const credits = await CreditNote.find({ organizationId: org, status: { $in: ["issued", "applied"] }, ...(ranged ? { issuedAt: range } : {}) })
    .select("creditNoteNumber invoiceId customerName issuedAt totalMinor reason").lean<any[]>();
  const invoiceFilter: Record<string, unknown> = { organizationId: org, status: { $nin: ["draft", "void"] } };
  const invoices = q.basis === "invoiced"
    ? await Invoice.find({ ...invoiceFilter, $or: [
      ranged ? { issueDate: range } : {}, { _id: { $in: credits.map((c) => c.invoiceId) } },
      // A pro-forma is invoiced as each payment's tax invoice is, on the day it was paid.
      { "proforma.at": { $exists: true }, ...(ranged ? { payments: { $elemMatch: { paidOn: range } } } : {}) },
    ] }).select(SELECT).lean<any[]>()
    : await Invoice.find({ ...invoiceFilter, ...(ranged ? { payments: { $elemMatch: { paidOn: range } } } : { "payments.0": { $exists: true } }) }).select(SELECT).lean<any[]>();

  const rate = (inv: any) => Number(inv.exchangeRate) > 0 ? Number(inv.exchangeRate) : 1;
  const invoiceDims = (inv: any, date: string): Record<string, string> => {
    const sp = inv.salespersonId ? String(inv.salespersonId) : NONE;
    const dept = deptOf.get(sp) ?? NONE;
    const crm = crmOf(inv);
    const course = String(inv.enrolment?.course || inv.lineItems?.[0]?.description || "").trim();
    const academy = (ACADEMIES as readonly string[]).includes(inv.enrolment?.academy) ? inv.enrolment.academy : NONE;
    return {
      salesperson: names.set("salesperson", sp, inv.salespersonName || "No salesperson"),
      department: names.set("department", dept, dept === NONE ? "No department" : depts.get(dept) ?? "A removed department"),
      course: names.set("course", course.toLowerCase() || NONE, course || "—"),
      customer: names.set("customer", inv.customerId ? String(inv.customerId) : NONE, inv.customerName || "—"),
      crm: names.set("crm", crm.key, crm.name),
      academy: names.set("academy", academy, academy === "dubai" ? "Dubai" : academy === "bangalore" ? "Bangalore" : "Not said"),
      status: names.set("status", inv.status === "viewed" ? "sent" : String(inv.status), INVOICE_STATUS[inv.status] ?? String(inv.status)),
      month: names.set("month", date.slice(0, 7), monthName(date.slice(0, 7))),
    };
  };

  const records: AnalysisRecord[] = [];
  const byId = new Map(invoices.map((i) => [String(i._id), i]));
  if (q.basis === "invoiced") {
    for (const inv of invoices) {
      // A pro-forma is not a tax invoice (invoice/payment-tax-invoice.ts): what is invoiced on it is each payment's
      // tax invoice, by the day it was paid — paid in full, the rest of the course not yet invoiced.
      if (inv.proforma?.at) {
        for (const p of inv.payments ?? []) {
          if (!p.taxInvoice?.number || (!inRange(p.paidOn) && ranged)) continue;
          const date = dayOf(p.paidOn);
          const amount = Math.round((p.amountMinor ?? 0) * rate(inv));
          records.push({
            id: `ti:${inv._id}:${p._id}`, date, number: p.taxInvoice.number, title: inv.customerName ?? "",
            detail: [`Payment towards ${inv.invoiceNumber}`, inv.salespersonName].filter(Boolean).join(" · "), amountMinor: amount,
            collectedMinor: amount, owedMinor: 0, href: `/invoices/${inv._id}`,
            dims: { ...invoiceDims(inv, date), method: names.set("method", NONE, "—"), bank: names.set("bank", NONE, "—") },
          });
        }
        continue;
      }
      if (!inRange(inv.issueDate) && ranged) continue;
      const date = dayOf(inv.issueDate);
      const amount = inv.baseTotalMinor || Math.round((inv.totalMinor ?? 0) * rate(inv));
      // What has come in on it so far, and what is still owed — a part-paid invoice is not all cash.
      const collected = (inv.payments ?? []).reduce((s: number, p: any) => s + Math.round((p.amountMinor ?? 0) * rate(inv)), 0);
      records.push({
        id: String(inv._id), date, number: inv.invoiceNumber, title: inv.customerName ?? "", detail: inv.salespersonName ?? "", amountMinor: amount,
        collectedMinor: collected, owedMinor: Math.round((inv.balanceMinor ?? 0) * rate(inv)),
        href: `/invoices/${inv._id}`,
        dims: { ...invoiceDims(inv, date), method: names.set("method", NONE, "—"), bank: names.set("bank", NONE, "—") },
      });
    }
    for (const c of credits) {
      const inv = byId.get(String(c.invoiceId));
      if (!inv) continue;
      const date = dayOf(c.issuedAt);
      records.push({
        id: `cn:${c._id}`, date, number: c.creditNoteNumber, title: c.customerName ?? inv.customerName ?? "", detail: `Credit note on ${inv.invoiceNumber}${c.reason ? ` — ${c.reason}` : ""}`,
        amountMinor: -Math.round((c.totalMinor ?? 0) * rate(inv)), href: `/credit-notes/${c._id}`,
        dims: { ...invoiceDims(inv, date), method: names.set("method", NONE, "—"), bank: names.set("bank", NONE, "—") },
      });
    }
  } else {
    for (const inv of invoices) {
      for (const p of inv.payments ?? []) {
        if (!inRange(p.paidOn) && ranged) continue;
        const date = dayOf(p.paidOn);
        const bank = p.bankAccountId ? String(p.bankAccountId) : NONE;
        const recorded = Math.round((p.amountMinor ?? 0) * rate(inv));
        // Paid in another currency than the invoice's (rupees on an AED invoice): as it was paid, never what it was
        // converted to (the user, 2026-11-26) — or, its amount there never recorded, as recorded and said so.
        const invoiceCurrency = inv.currency || apartFrom;
        const paidIn = apartFrom ? paidCurrency(p, invoiceCurrency) : null;
        const paid = paidIn ? paidAmountMinor(p, invoiceCurrency) : 0;
        records.push({
          id: `${inv._id}:${p._id ?? date}`, date, number: p.receiptNumber || inv.invoiceNumber, title: inv.customerName ?? "",
          detail: [inv.invoiceNumber, methodName(String(p.method ?? "other")), inv.salespersonName].filter(Boolean).join(" · "),
          ...(paidIn && paid > 0 ? { amountMinor: paid, currency: paidIn, recordedMinor: recorded } : { amountMinor: recorded, ...(paidIn ? { paidIn } : {}) }),
          href: `/invoices/${inv._id}`,
          dims: {
            ...invoiceDims(inv, date),
            method: names.set("method", String(p.method ?? NONE), p.method ? methodName(String(p.method)) : "Not said"),
            bank: names.set("bank", bank, bank === NONE ? (p.accountName || "No bank account") : banks.get(bank) ?? (p.accountName || "A removed account")),
          },
        });
      }
    }
  }

  // Worked out afresh for each set of records it is given — every currency's, then the one shown (2026-11-07) — so
  // nothing is carried from one call into the next.
  const extraTotals = (kept: AnalysisRecord[]): Partial<AnalysisReport["totals"]> => {
    let invoicedMinor = 0, creditMinor = 0, outstandingMinor = 0, collectedMinor = 0;
    if (q.basis === "invoiced") {
      invoicedMinor = kept.filter((r) => r.amountMinor >= 0 && !r.id.startsWith("cn:")).reduce((s, r) => s + r.amountMinor, 0);
      creditMinor = -kept.filter((r) => r.id.startsWith("cn:")).reduce((s, r) => s + r.amountMinor, 0);
      // A payment's tax invoice is paid in full.
      collectedMinor += kept.filter((r) => r.id.startsWith("ti:")).reduce((s, r) => s + r.amountMinor, 0);
      const ids = new Set(kept.filter((r) => !r.id.startsWith("cn:") && !r.id.startsWith("ti:")).map((r) => r.id));
      for (const id of ids) {
        const inv = byId.get(id);
        if (!inv) continue;
        outstandingMinor += Math.round((inv.balanceMinor ?? 0) * rate(inv));
        for (const p of inv.payments ?? []) collectedMinor += Math.round((p.amountMinor ?? 0) * rate(inv));
      }
      return { invoicedMinor, creditMinor, collectedMinor, outstandingMinor };
    }
    collectedMinor = kept.reduce((s, r) => s + r.amountMinor, 0);
    return { collectedMinor };
  };
  return { records, extraTotals };
}

/** Reads the filter keys a report allows from a query string; unknown ones are refused. */
export function analysisFilters(query: Record<string, unknown>, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dim of allowed) {
    const v = query[dim];
    // Several values of one dimension (?course=a&course=b — Root's Report Org, 2026-11-27): any of them keeps a record.
    const list = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && x !== "").map((x) => x.slice(0, 200)).slice(0, MANY);
    if (list.length) out[dim] = list.join(ANY_OF);
  }
  return out;
}

/**
 * Between the values of one dimension when several are asked for: a character no key has, so a course or an account
 * named with a comma is still one value. One value — every caller before this — has none and is compared as it was.
 */
const ANY_OF = "\u001f";
const MANY = 50;
/** Whether a record's key in a dimension is the one asked for, or one of the several. */
const keeps1 = (asked: string, key: string) => (asked.includes(ANY_OF) ? asked.split(ANY_OF).includes(key) : asked === key);

export { EXPENSE_DIMENSION_KEYS, REVENUE_DIMENSION_KEYS };
