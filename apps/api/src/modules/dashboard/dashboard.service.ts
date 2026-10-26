import { Types } from "mongoose";
import {
  AGING_BAND_LABELS,
  PAYMENT_METHOD_LABELS,
  categoryLabel,
  type AgingBand,
  type DailyBreakdownGroup,
  type DailyBreakdownRecord,
  type DashboardBreakdown,
  type DashboardBreakdownKind,
  type PaymentMethod,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { Invoice } from "../invoice/invoice.model";
import { Bill } from "../bill/bill.model";
import { Expense } from "../expense/expense.model";
import { categoryNameMap, pnlExpenseFilter } from "../expense-category/expense-category.service";
import { crmOf } from "../reports/reports.service";

function oid(id: string) { return new Types.ObjectId(id); }

/*
 * Months and days are Dubai's (the user, 2026-10-26: the dashboard counted by UTC, so what happened before 4 am on the
 * 1st went into the month before). Dubai has no daylight saving, so it is UTC+4 all year.
 */
const DUBAI_OFFSET_MS = 4 * 60 * 60 * 1000;
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Dubai's calendar day of an instant, YYYY-MM-DD. */
function dubaiDay(d: Date): string { return new Date(d.getTime() + DUBAI_OFFSET_MS).toISOString().slice(0, 10); }
/** Its Dubai day, YYYY-MM-DD — the same day for a date-only value (midnight UTC is 4 am in Dubai). */
function dateOnly(d: Date | string | undefined | null): string { return d ? dubaiDay(new Date(d)) : ""; }

type Month = { y: number; m: number }; // m 0–11
function thisMonth(now: Date): Month { const d = dubaiDay(now); return { y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) - 1 }; }
function shift({ y, m }: Month, by: number): Month { const t = new Date(Date.UTC(y, m + by, 1)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() }; }
function monthKey({ y, m }: Month): string { return `${y}-${String(m + 1).padStart(2, "0")}`; }
function parseMonth(key: string | undefined): Month {
  const hit = /^(\d{4})-(\d{2})$/.exec(key ?? "");
  if (!hit || Number(hit[2]) < 1 || Number(hit[2]) > 12) throw new AppError("VALIDATION_ERROR", "month must be YYYY-MM");
  return { y: Number(hit[1]), m: Number(hit[2]) - 1 };
}
/** The instants Dubai's month begins and the next one begins: [from, to). */
function bounds({ y, m }: Month): { from: Date; to: Date } {
  return { from: new Date(Date.UTC(y, m, 1) - DUBAI_OFFSET_MS), to: new Date(Date.UTC(y, m + 1, 1) - DUBAI_OFFSET_MS) };
}
function monthName({ y, m }: Month): string { return `${MONTH_NAMES[m]} ${y}`; }

/** Days past due, by Dubai's today; 0 or less is not due yet. */
function daysLate(dueDate: Date | undefined, today: string): number {
  if (!dueDate) return 0;
  return Math.round((Date.parse(today) - Date.parse(dateOnly(dueDate))) / 86_400_000);
}
function bandOf(days: number): AgingBand {
  return days <= 0 ? "current" : days <= 30 ? "1-30" : days <= 60 ? "31-60" : days <= 90 ? "61-90" : "90+";
}

// ── The rules — one place, used by the figures and by their breakdowns, so the two always agree ──────────────────

/** Invoices whose money is still owed: issued, not void or paid, something left. */
const OPEN_INVOICE = { status: { $in: ["sent", "viewed", "partial", "overdue"] }, balanceMinor: { $gt: 0 } };
/** Bills still owed. */
const OPEN_BILL = { status: { $in: ["approved", "partially_paid", "overdue"] }, balanceMinor: { $gt: 0 } };
/**
 * Approved expenses nobody has paid yet (2026-10-26: payables counted only bills — the procurement approvals and
 * every other unpaid expense were missing). A bill's own expense is its bill, already counted.
 */
const UNPAID_EXPENSE = { status: "approved", paidOn: null, "source.kind": { $ne: "bill" } };

function revenueMatch(orgId: string, from: Date, to: Date) {
  return { organizationId: oid(orgId), issueDate: { $gte: from, $lt: to }, status: { $nin: ["draft", "void"] } };
}
function billCostMatch(orgId: string, from: Date, to: Date) {
  return { organizationId: oid(orgId), billDate: { $gte: from, $lt: to }, status: { $nin: ["draft", "voided"] } };
}
/** Expenses in the profit and loss (advances, payroll clearing, VAT, loan principal are not), bills apart. */
function expenseCostMatch(orgId: string, from: Date, to: Date, pnl: Record<string, unknown>) {
  return { organizationId: oid(orgId), expenseDate: { $gte: from, $lt: to }, status: { $in: ["approved", "submitted"] }, "source.kind": { $ne: "bill" }, ...pnl };
}

type Movement = DailyBreakdownRecord & { at: Date };

/**
 * Money in and out between from and to: payments received on invoices; payments made on bills, and every expense
 * paid (2026-10-26: money out counted only bill payments, so the expenses paid directly — most of what goes out —
 * were missing). All of it, profit-and-loss or not: an advance or a VAT payment is money out all the same.
 */
async function movements(orgId: string, from: Date, to: Date): Promise<{ inflow: Movement[]; outflow: Movement[] }> {
  const [invoices, bills, expenses] = await Promise.all([
    Invoice.find({ organizationId: oid(orgId), status: { $ne: "void" }, payments: { $elemMatch: { paidOn: { $gte: from, $lt: to } } } })
      .select("invoiceNumber customerName salespersonName currency payments enrolment.crm external.source").lean<any[]>(),
    Bill.find({ organizationId: oid(orgId), status: { $ne: "voided" }, payments: { $elemMatch: { paidOn: { $gte: from, $lt: to } } } })
      .select("billNumber vendorName categoryName subcategoryName currency payments").lean<any[]>(),
    Expense.find({ organizationId: oid(orgId), status: "approved", "source.kind": { $ne: "bill" }, paidOn: { $gte: from, $lt: to } })
      .select("expenseNumber description categoryName subcategoryName totalMinor currency paidOn paymentMethod paymentAccount submittedByName").lean<any[]>(),
  ]);
  const method = (m: unknown) => PAYMENT_METHOD_LABELS[m as PaymentMethod] ?? (m ? String(m).replace(/_/g, " ") : "—");
  const inflow: Movement[] = [];
  for (const inv of invoices) {
    const salesperson = inv.salespersonName || "—";
    for (const p of inv.payments ?? []) {
      const at = new Date(p.paidOn);
      if (at < from || at >= to) continue;
      inflow.push({
        at, id: `${inv._id}:${p._id ?? at.getTime()}`, date: dubaiDay(at), number: p.receiptNumber || inv.invoiceNumber, title: inv.customerName ?? "",
        detail: [inv.invoiceNumber, method(p.method)].join(" · "), amountMinor: p.amountMinor ?? 0, currency: inv.currency ?? "AED",
        href: `/invoices/${inv._id}`, groups: { method: method(p.method), salesperson, crm: crmOf(inv) },
      });
    }
  }
  const outflow: Movement[] = [];
  for (const b of bills) {
    for (const p of b.payments ?? []) {
      const at = new Date(p.paidOn);
      if (at < from || at >= to) continue;
      outflow.push({
        at, id: `${b._id}:${p._id ?? at.getTime()}`, date: dubaiDay(at), number: b.billNumber, title: b.vendorName ?? "",
        detail: [categoryLabel(b.categoryName, b.subcategoryName), method(p.method)].filter(Boolean).join(" · "), amountMinor: p.amountMinor ?? 0,
        currency: b.currency ?? "AED", href: `/bills/${b._id}`,
        groups: { type: "Bill payments", category: b.categoryName || "—", paidFrom: method(p.method) },
      });
    }
  }
  for (const e of expenses) {
    const at = new Date(e.paidOn);
    outflow.push({
      at, id: String(e._id), date: dubaiDay(at), number: e.expenseNumber, title: categoryLabel(e.categoryName, e.subcategoryName) || "Expense",
      detail: e.description ?? "", amountMinor: e.totalMinor ?? 0, currency: e.currency ?? "AED", href: `/expenses/${e._id}`,
      groups: { type: "Expenses paid", category: e.categoryName || "—", paidFrom: e.paymentAccount || method(e.paymentMethod) },
    });
  }
  return { inflow, outflow };
}

// ── The dashboard ────────────────────────────────────────────────────────────────────────────────────────────────

export interface DashboardStats {
  currency: string;
  kpi: {
    revenueMtd: number;
    revenueLastMonth: number;
    revenueTrend: number; // percent change
    receivables: number;
    payables: number;
    /** Of payables: bills, and approved expenses not paid yet. */
    payablesBills: number;
    payablesExpenses: number;
    netProfitMtd: number;
    netProfitLastMonth: number;
    overdueCount: number;
    overdueAmount: number;
  };
  /** This month and last, YYYY-MM (Dubai) — what a card's breakdown asks for. */
  months: { current: string; last: string };
  cashflow: Array<{ month: string; key: string; inflowMinor: number; outflowMinor: number }>;
  recentInvoices: Array<{
    id: string;
    number: string;
    customerName: string;
    status: string;
    dueDate: string;
    totalMinor: number;
    balanceMinor: number;
  }>;
  topCustomers: Array<{ name: string; revenueMinor: number; invoiceCount: number }>;
  expenseBreakdown: Array<{ category: string; categoryKey: string; totalMinor: number }>;
  aging: { current: number; band1to30: number; band31to60: number; band61to90: number; band90plus: number; total: number };
}

export async function getDashboardStats(orgId: string, currency = "AED"): Promise<DashboardStats> {
  const now = new Date();
  const today = dubaiDay(now);
  const cur = thisMonth(now);
  const last = shift(cur, -1);
  const mtd = bounds(cur), lm = bounds(last);
  const sixMonths = { from: bounds(shift(cur, -5)).from, to: mtd.to };
  const threeMonths = { from: bounds(shift(cur, -2)).from, to: mtd.to };

  // Expense figures here are profit-and-loss ones: advances, payroll clearing, VAT, loan principal are left out.
  const pnl = await pnlExpenseFilter(orgId);
  const sum = async (model: any, match: Record<string, unknown>, field: string): Promise<number> =>
    ((await model.aggregate([{ $match: match }, { $group: { _id: null, total: { $sum: `$${field}` } } }]))[0]?.total as number) ?? 0;

  const [
    revMtd, revLm,
    billsOwed, expensesOwed,
    billsMtd, expsMtd, billsLm, expsLm,
    openInvs,
    recentInvs,
    topCustAgg,
    expByCatAgg,
    cash,
  ] = await Promise.all([
    sum(Invoice, revenueMatch(orgId, mtd.from, mtd.to), "subtotalMinor"),
    sum(Invoice, revenueMatch(orgId, lm.from, lm.to), "subtotalMinor"),
    sum(Bill, { organizationId: oid(orgId), ...OPEN_BILL }, "balanceMinor"),
    sum(Expense, { organizationId: oid(orgId), ...UNPAID_EXPENSE }, "totalMinor"),
    sum(Bill, billCostMatch(orgId, mtd.from, mtd.to), "subtotalMinor"),
    sum(Expense, expenseCostMatch(orgId, mtd.from, mtd.to, pnl), "totalMinor"),
    sum(Bill, billCostMatch(orgId, lm.from, lm.to), "subtotalMinor"),
    sum(Expense, expenseCostMatch(orgId, lm.from, lm.to, pnl), "totalMinor"),
    // Receivables, overdue and aging all come from this one list, so they agree with each other.
    Invoice.find({ organizationId: oid(orgId), ...OPEN_INVOICE }).select("dueDate balanceMinor").lean<any[]>(),
    Invoice.find({ organizationId: oid(orgId), status: { $ne: "void" } })
      .sort({ createdAt: -1 }).limit(7)
      .select("invoiceNumber customerName status dueDate totalMinor balanceMinor")
      .lean<any[]>(),
    // Top customers (last 6 months)
    Invoice.aggregate([
      { $match: revenueMatch(orgId, sixMonths.from, sixMonths.to) },
      { $group: { _id: "$customerName", revenue: { $sum: "$subtotalMinor" }, count: { $sum: 1 } } },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
    ]),
    // Expense by category (last 3 months)
    Expense.aggregate([
      { $match: categoryMatch(orgId, threeMonths.from, threeMonths.to, pnl) },
      { $group: { _id: "$category", total: { $sum: "$totalMinor" } } },
      { $sort: { total: -1 } },
      { $limit: 6 },
    ]),
    movements(orgId, sixMonths.from, sixMonths.to),
  ]);

  // Cash flow by month (last 6 months)
  const monthMap = new Map<string, { inflowMinor: number; outflowMinor: number }>();
  for (let i = 5; i >= 0; i--) monthMap.set(monthKey(shift(cur, -i)), { inflowMinor: 0, outflowMinor: 0 });
  for (const mv of cash.inflow) { const b = monthMap.get(mv.date.slice(0, 7)); if (b) b.inflowMinor += mv.amountMinor; }
  for (const mv of cash.outflow) { const b = monthMap.get(mv.date.slice(0, 7)); if (b) b.outflowMinor += mv.amountMinor; }
  const cashflow = [...monthMap.entries()].map(([key, val]) => {
    const [y, m] = key.split("-").map(Number);
    return { month: `${MONTH_LABELS[m! - 1]} ${y}`, key, ...val };
  });

  // Aging, receivables, overdue — by Dubai's today against the due date's day.
  const aging = { current: 0, band1to30: 0, band31to60: 0, band61to90: 0, band90plus: 0, total: 0 };
  const field: Record<AgingBand, keyof typeof aging> = { current: "current", "1-30": "band1to30", "31-60": "band31to60", "61-90": "band61to90", "90+": "band90plus" };
  let overdueCount = 0, overdueAmount = 0;
  for (const inv of openInvs) {
    const bal = inv.balanceMinor ?? 0;
    const days = daysLate(inv.dueDate, today);
    aging.total += bal;
    aging[field[bandOf(days)]] += bal;
    // Late is late whatever the status says — an invoice already marked "overdue" counts too (it used not to).
    if (days > 0) { overdueCount++; overdueAmount += bal; }
  }

  const catNameMap = await categoryNameMap(orgId);
  const totalExpMtd = billsMtd + expsMtd;
  const totalExpLm = billsLm + expsLm;

  return {
    currency,
    kpi: {
      revenueMtd: revMtd,
      revenueLastMonth: revLm,
      revenueTrend: revLm > 0 ? Math.round(((revMtd - revLm) / revLm) * 100) : 0,
      receivables: aging.total,
      payables: billsOwed + expensesOwed,
      payablesBills: billsOwed,
      payablesExpenses: expensesOwed,
      netProfitMtd: revMtd - totalExpMtd,
      netProfitLastMonth: revLm - totalExpLm,
      overdueCount,
      overdueAmount,
    },
    months: { current: monthKey(cur), last: monthKey(last) },
    cashflow,
    recentInvoices: recentInvs.map((d) => ({
      id: d._id.toString(),
      number: d.invoiceNumber,
      customerName: d.customerName,
      status: d.status,
      dueDate: dateOnly(d.dueDate),
      totalMinor: d.totalMinor ?? 0,
      balanceMinor: d.balanceMinor ?? 0,
    })),
    topCustomers: topCustAgg.map((c: { _id: string; revenue: number; count: number }) => ({
      name: c._id,
      revenueMinor: c.revenue,
      invoiceCount: c.count,
    })),
    expenseBreakdown: expByCatAgg.map((e: { _id: string; total: number }) => ({
      category: catNameMap.get(e._id) || e._id || "Other",
      categoryKey: e._id ?? "",
      totalMinor: e.total,
    })),
    aging,
  };
}

/** The expense chart's rule: approved and submitted expenses in the profit and loss — a bill's own expense included. */
function categoryMatch(orgId: string, from: Date, to: Date, pnl: Record<string, unknown>) {
  return { organizationId: oid(orgId), expenseDate: { $gte: from, $lt: to }, status: { $in: ["approved", "submitted"] }, ...pnl };
}

// ── Breakdowns ───────────────────────────────────────────────────────────────────────────────────────────────────

const GROUPS: Record<DashboardBreakdownKind, { key: string; label: string }[]> = {
  revenue: [{ key: "salesperson", label: "Salesperson" }, { key: "crm", label: "CRM" }, { key: "customer", label: "Customer" }],
  expenses: [{ key: "type", label: "Type" }, { key: "category", label: "Category" }, { key: "who", label: "Vendor or department" }],
  cash_in: [{ key: "method", label: "Method" }, { key: "salesperson", label: "Salesperson" }, { key: "crm", label: "CRM" }],
  cash_out: [{ key: "type", label: "Type" }, { key: "category", label: "Category" }, { key: "paidFrom", label: "Paid from" }],
  receivables: [{ key: "customer", label: "Customer" }, { key: "age", label: "Age" }, { key: "salesperson", label: "Salesperson" }, { key: "crm", label: "CRM" }],
  overdue: [{ key: "customer", label: "Customer" }, { key: "age", label: "Age" }, { key: "salesperson", label: "Salesperson" }],
  aging: [{ key: "customer", label: "Customer" }, { key: "salesperson", label: "Salesperson" }, { key: "crm", label: "CRM" }],
  payables: [{ key: "type", label: "Type" }, { key: "who", label: "Vendor or submitted by" }, { key: "category", label: "Category" }, { key: "due", label: "Due" }],
  category: [{ key: "subcategory", label: "Subcategory" }, { key: "department", label: "Department" }, { key: "submittedBy", label: "Submitted by" }, { key: "month", label: "Month" }],
  customer: [{ key: "salesperson", label: "Salesperson" }, { key: "month", label: "Month" }, { key: "status", label: "Status" }],
};

/** Which breakdowns show expenses and bills (the rest show invoices) — they need report:read or expense:read. */
export const EXPENSE_BREAKDOWNS: readonly DashboardBreakdownKind[] = ["expenses", "cash_out", "payables", "category"];

export interface BreakdownQuery { kind: DashboardBreakdownKind; month?: string; band?: string; category?: string; customer?: string }

/**
 * The records behind a dashboard figure, by exactly the rules of getDashboardStats above — so they add up to it — and
 * grouped (the user, 2026-10-26).
 */
export async function getDashboardBreakdown(orgId: string, q: BreakdownQuery): Promise<DashboardBreakdown> {
  const now = new Date();
  const today = dubaiDay(now);
  const asOf = `as of ${new Date(`${today}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}`;
  const records: DailyBreakdownRecord[] = [];
  let title = "", scope = "";

  const invoiceRecord = (inv: any, amountMinor: number, extra: Record<string, string> = {}): DailyBreakdownRecord => {
    const days = daysLate(inv.dueDate, today);
    return {
      id: String(inv._id), date: dateOnly(inv.issueDate), number: inv.invoiceNumber, title: inv.customerName ?? "",
      detail: [inv.salespersonName, inv.dueDate ? (days > 0 ? `due ${dateOnly(inv.dueDate)} · ${days} day${days === 1 ? "" : "s"} late` : `due ${dateOnly(inv.dueDate)}`) : ""].filter(Boolean).join(" · "),
      amountMinor, currency: inv.currency ?? "AED", href: `/invoices/${inv._id}`,
      groups: {
        salesperson: inv.salespersonName || "—", crm: crmOf(inv), customer: inv.customerName || "—", age: AGING_BAND_LABELS[bandOf(days)],
        month: dateOnly(inv.issueDate).slice(0, 7), status: String(inv.status ?? "—"), ...extra,
      },
    };
  };
  const INVOICE_FIELDS = "invoiceNumber customerName salespersonName issueDate dueDate status subtotalMinor balanceMinor currency enrolment.crm external.source";

  switch (q.kind) {
    case "revenue": {
      const month = parseMonth(q.month), { from, to } = bounds(month);
      title = "Revenue"; scope = `${monthName(month)} · invoices issued, before VAT`;
      const invs = await Invoice.find(revenueMatch(orgId, from, to)).select(INVOICE_FIELDS).lean<any[]>();
      for (const inv of invs) records.push(invoiceRecord(inv, inv.subtotalMinor ?? 0));
      break;
    }
    case "customer": {
      const name = (q.customer ?? "").trim();
      if (!name) throw new AppError("VALIDATION_ERROR", "customer is required");
      const cur = thisMonth(now), from = bounds(shift(cur, -5)).from, to = bounds(cur).to;
      title = name; scope = `Invoices issued, ${MONTH_LABELS[shift(cur, -5).m]} – ${monthName(cur)}, before VAT`;
      const invs = await Invoice.find({ ...revenueMatch(orgId, from, to), customerName: name }).select(INVOICE_FIELDS).lean<any[]>();
      for (const inv of invs) records.push(invoiceRecord(inv, inv.subtotalMinor ?? 0));
      break;
    }
    case "receivables":
    case "overdue":
    case "aging": {
      const band = q.kind === "aging" ? (q.band as AgingBand) : undefined;
      if (q.kind === "aging" && !(band && band in AGING_BAND_LABELS)) throw new AppError("VALIDATION_ERROR", "band must be one of current, 1-30, 31-60, 61-90, 90+");
      title = q.kind === "receivables" ? "Outstanding receivables" : q.kind === "overdue" ? "Overdue invoices" : `Receivables — ${AGING_BAND_LABELS[band!]}`;
      scope = `${asOf} · what is still owed on each invoice`;
      const invs = await Invoice.find({ organizationId: oid(orgId), ...OPEN_INVOICE }).select(INVOICE_FIELDS).lean<any[]>();
      for (const inv of invs) {
        const days = daysLate(inv.dueDate, today);
        if (q.kind === "overdue" && days <= 0) continue;
        if (band && bandOf(days) !== band) continue;
        records.push(invoiceRecord(inv, inv.balanceMinor ?? 0));
      }
      break;
    }
    case "payables": {
      title = "Outstanding payables"; scope = `${asOf} · bills still owed and approved expenses not paid yet`;
      const [bills, expenses] = await Promise.all([
        Bill.find({ organizationId: oid(orgId), ...OPEN_BILL }).select("billNumber vendorName billDate dueDate categoryName subcategoryName balanceMinor currency").lean<any[]>(),
        Expense.find({ organizationId: oid(orgId), ...UNPAID_EXPENSE })
          .select("expenseNumber description expenseDate dueDate categoryName subcategoryName submittedByName totalMinor currency").lean<any[]>(),
      ]);
      const due = (d: Date | undefined) => !d ? "No due date" : daysLate(d, today) > 0 ? "Overdue" : "Not due yet";
      for (const b of bills) {
        records.push({
          id: String(b._id), date: dateOnly(b.billDate), number: b.billNumber, title: b.vendorName ?? "",
          detail: [categoryLabel(b.categoryName, b.subcategoryName), b.dueDate ? `due ${dateOnly(b.dueDate)}` : ""].filter(Boolean).join(" · "),
          amountMinor: b.balanceMinor ?? 0, currency: b.currency ?? "AED", href: `/bills/${b._id}`,
          groups: { type: "Bills", who: b.vendorName || "—", category: b.categoryName || "—", due: due(b.dueDate) },
        });
      }
      for (const e of expenses) {
        records.push({
          id: String(e._id), date: dateOnly(e.expenseDate), number: e.expenseNumber, title: categoryLabel(e.categoryName, e.subcategoryName) || "Expense",
          detail: [e.description, e.dueDate ? `due ${dateOnly(e.dueDate)}` : ""].filter(Boolean).join(" · "),
          amountMinor: e.totalMinor ?? 0, currency: e.currency ?? "AED", href: `/expenses/${e._id}`,
          groups: { type: "Unpaid expenses", who: e.submittedByName || "—", category: e.categoryName || "—", due: due(e.dueDate) },
        });
      }
      break;
    }
    case "expenses": {
      const month = parseMonth(q.month), { from, to } = bounds(month);
      title = "Expenses"; scope = `${monthName(month)} · bills and expenses in the profit and loss, as Net Profit counts them`;
      const pnl = await pnlExpenseFilter(orgId);
      const [bills, expenses] = await Promise.all([
        Bill.find(billCostMatch(orgId, from, to)).select("billNumber vendorName billDate categoryName subcategoryName subtotalMinor currency").lean<any[]>(),
        Expense.find(expenseCostMatch(orgId, from, to, pnl)).select("expenseNumber description expenseDate categoryName subcategoryName totalMinor currency departmentId status")
          .populate("departmentId", "name").lean<any[]>(),
      ]);
      for (const b of bills) {
        records.push({
          id: String(b._id), date: dateOnly(b.billDate), number: b.billNumber, title: b.vendorName ?? "", detail: categoryLabel(b.categoryName, b.subcategoryName) || "",
          amountMinor: b.subtotalMinor ?? 0, currency: b.currency ?? "AED", href: `/bills/${b._id}`,
          groups: { type: "Bills", category: b.categoryName || "—", who: b.vendorName || "—" },
        });
      }
      for (const e of expenses) {
        records.push({
          id: String(e._id), date: dateOnly(e.expenseDate), number: e.expenseNumber, title: categoryLabel(e.categoryName, e.subcategoryName) || "Expense",
          detail: [e.description, e.status === "submitted" ? "waiting for approval" : ""].filter(Boolean).join(" · "),
          amountMinor: e.totalMinor ?? 0, currency: e.currency ?? "AED", href: `/expenses/${e._id}`,
          groups: { type: "Expenses", category: e.categoryName || "—", who: (e.departmentId as { name?: string } | null)?.name || "No department" },
        });
      }
      break;
    }
    case "cash_in":
    case "cash_out": {
      const month = parseMonth(q.month), { from, to } = bounds(month);
      title = q.kind === "cash_in" ? "Money in" : "Money out";
      scope = `${monthName(month)} · ${q.kind === "cash_in" ? "payments received on invoices" : "bill payments and expenses paid"}`;
      const { inflow, outflow } = await movements(orgId, from, to);
      for (const { at: _at, ...r } of q.kind === "cash_in" ? inflow : outflow) records.push(r);
      break;
    }
    case "category": {
      const slug = (q.category ?? "").trim();
      if (!slug) throw new AppError("VALIDATION_ERROR", "category is required");
      const cur = thisMonth(now), from = bounds(shift(cur, -2)).from, to = bounds(cur).to;
      const pnl = await pnlExpenseFilter(orgId);
      const names = await categoryNameMap(orgId);
      title = names.get(slug) || slug; scope = `Expenses, ${MONTH_LABELS[shift(cur, -2).m]} – ${monthName(cur)}`;
      const expenses = await Expense.find({ ...categoryMatch(orgId, from, to, pnl), category: slug })
        .select("expenseNumber description expenseDate categoryName subcategoryName totalMinor currency submittedByName departmentId status")
        .populate("departmentId", "name").lean<any[]>();
      for (const e of expenses) {
        records.push({
          id: String(e._id), date: dateOnly(e.expenseDate), number: e.expenseNumber, title: categoryLabel(e.categoryName, e.subcategoryName) || "Expense",
          detail: [e.description, e.status === "submitted" ? "waiting for approval" : ""].filter(Boolean).join(" · "),
          amountMinor: e.totalMinor ?? 0, currency: e.currency ?? "AED", href: `/expenses/${e._id}`,
          groups: {
            subcategory: e.subcategoryName || "No subcategory", department: (e.departmentId as { name?: string } | null)?.name || "No department",
            submittedBy: e.submittedByName || "—", month: dateOnly(e.expenseDate).slice(0, 7),
          },
        });
      }
      break;
    }
    default:
      throw new AppError("VALIDATION_ERROR", "Unknown breakdown");
  }

  records.sort((a, b) => b.date.localeCompare(a.date) || b.amountMinor - a.amountMinor);
  const groups: DailyBreakdownGroup[] = GROUPS[q.kind].map(({ key, label }) => {
    const by = new Map<string, { name: string; count: number; amountMinor: number }>();
    for (const r of records) {
      const name = r.groups[key] ?? "—";
      const g = by.get(name) ?? { name, count: 0, amountMinor: 0 };
      g.count++;
      g.amountMinor += r.amountMinor;
      by.set(name, g);
    }
    return { key, label, items: [...by.values()].sort((a, b) => b.amountMinor - a.amountMinor) };
  });
  return { kind: q.kind, title, scope, totalMinor: records.reduce((t, r) => t + r.amountMinor, 0), count: records.length, groups, records };
}
