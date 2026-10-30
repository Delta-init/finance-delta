import { Types } from "mongoose";
import {
  ACADEMIES,
  ENROLMENT_CRM_LABELS,
  OLD_BOOKS_SOURCE,
  PAYMENT_METHOD_LABELS,
  categoryLabel,
  enrolmentCrm,
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
    for (const [dim, key] of Object.entries(q.filters)) if ((r.dims[dim] ?? NONE) !== key) return false;
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
  const groups = group(kept, q.groupBy);
  if (q.groupBy === "category") {
    for (const g of groups) g.sub = group(kept.filter((r) => (r.dims.category ?? NONE) === g.key), "subcategory");
  }
  const months = group(kept, "month").map((g) => ({ month: g.key, amountMinor: g.amountMinor, count: g.count })).sort((a, b) => a.month.localeCompare(b.month));

  kept.sort((a, b) => b.date.localeCompare(a.date) || b.amountMinor - a.amountMinor);
  return {
    kind, from: q.from, to: q.to, currency, basis: q.basis, groupBy: q.groupBy,
    totals: { amountMinor: kept.reduce((s, r) => s + r.amountMinor, 0), count: kept.length, ...extraTotals(kept) },
    groups, months, options,
    records: kept.slice(0, MAX_RECORDS),
    capped: kept.length > MAX_RECORDS,
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
  bill: "Supplier bill", hrms_procurement: "HRMS purchase", hrms_advance: "HRMS salary advance", hrms_one_time: "HRMS one-time payment", import: "Old books (imported)",
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
    .select("expenseNumber category categoryName subcategory subcategoryName description expenseDate paidOn totalMinor submittedById submittedByName salespersonId salespersonName departmentId paymentMethod bankAccountId paymentAccount source status")
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
      amountMinor: e.totalMinor ?? 0, href: `/expenses/${e._id}`,
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
function crmOf(inv: any): { key: string; name: string } {
  const crm = enrolmentCrm(inv.enrolment?.crm, inv.external?.source);
  if (crm) return { key: crm, name: ENROLMENT_CRM_LABELS[crm] };
  if (inv.external?.source === OLD_BOOKS_SOURCE) return { key: "old_books", name: "Old books" };
  return inv.external?.source ? { key: String(inv.external.source), name: String(inv.external.source) } : { key: NONE, name: "Typed in finance" };
}

export async function getRevenueAnalysis(orgId: string, q: AnalysisQuery): Promise<AnalysisReport> {
  if (q.basis !== "invoiced" && q.basis !== "collected") throw new AppError("VALIDATION_ERROR", "basis must be invoiced or collected");
  const org = oid(orgId);
  const range = { ...(q.from ? { $gte: startOf(q.from) } : {}), ...(q.to ? { $lte: endOf(q.to) } : {}) };
  const ranged = Object.keys(range).length > 0;
  const inRange = (d: Date | string | undefined) => !!d && (!q.from || new Date(d) >= startOf(q.from)) && (!q.to || new Date(d) <= endOf(q.to));
  const [currency, depts, banks] = await Promise.all([orgCurrency(orgId), departmentNames(orgId), bankNames(orgId)]);

  // Each salesperson's department here.
  const people = await User.find({ "memberships.organizationId": org }).select("memberships").lean<any[]>();
  const deptOf = new Map<string, string>();
  for (const u of people) {
    const m = (u.memberships ?? []).find((x: any) => String(x.organizationId) === orgId);
    if (m?.departmentId) deptOf.set(String(u._id), String(m.departmentId));
  }

  const SELECT = "invoiceNumber customerId customerName salespersonId salespersonName issueDate status totalMinor baseTotalMinor balanceMinor exchangeRate payments enrolment.course enrolment.crm enrolment.academy external.source lineItems.description";
  const credits = await CreditNote.find({ organizationId: org, status: { $in: ["issued", "applied"] }, ...(ranged ? { issuedAt: range } : {}) })
    .select("creditNoteNumber invoiceId customerName issuedAt totalMinor reason").lean<any[]>();
  const invoiceFilter: Record<string, unknown> = { organizationId: org, status: { $nin: ["draft", "void"] } };
  const invoices = q.basis === "invoiced"
    ? await Invoice.find({ ...invoiceFilter, $or: [ranged ? { issueDate: range } : {}, { _id: { $in: credits.map((c) => c.invoiceId) } }] }).select(SELECT).lean<any[]>()
    : await Invoice.find({ ...invoiceFilter, ...(ranged ? { payments: { $elemMatch: { paidOn: range } } } : { "payments.0": { $exists: true } }) }).select(SELECT).lean<any[]>();

  const names = new Names();
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
  let invoicedMinor = 0, creditMinor = 0, outstandingMinor = 0, collectedMinor = 0;
  const byId = new Map(invoices.map((i) => [String(i._id), i]));
  if (q.basis === "invoiced") {
    for (const inv of invoices) {
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
        records.push({
          id: `${inv._id}:${p._id ?? date}`, date, number: p.receiptNumber || inv.invoiceNumber, title: inv.customerName ?? "",
          detail: [inv.invoiceNumber, methodName(String(p.method ?? "other")), inv.salespersonName].filter(Boolean).join(" · "),
          amountMinor: Math.round((p.amountMinor ?? 0) * rate(inv)), href: `/invoices/${inv._id}`,
          dims: {
            ...invoiceDims(inv, date),
            method: names.set("method", String(p.method ?? NONE), p.method ? methodName(String(p.method)) : "Not said"),
            bank: names.set("bank", bank, bank === NONE ? (p.accountName || "No bank account") : banks.get(bank) ?? (p.accountName || "A removed account")),
          },
        });
      }
    }
  }

  return finish("revenue", q, currency, records, names, REVENUE_DIMENSION_KEYS, (kept) => {
    if (q.basis === "invoiced") {
      invoicedMinor = kept.filter((r) => r.amountMinor >= 0 && !r.id.startsWith("cn:")).reduce((s, r) => s + r.amountMinor, 0);
      creditMinor = -kept.filter((r) => r.id.startsWith("cn:")).reduce((s, r) => s + r.amountMinor, 0);
      const ids = new Set(kept.filter((r) => !r.id.startsWith("cn:")).map((r) => r.id));
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
  });
}

/** Reads the filter keys a report allows from a query string; unknown ones are refused. */
export function analysisFilters(query: Record<string, unknown>, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const dim of allowed) {
    const v = query[dim];
    if (typeof v === "string" && v) out[dim] = v.slice(0, 200);
  }
  return out;
}

export { EXPENSE_DIMENSION_KEYS, REVENUE_DIMENSION_KEYS };
