import { Types } from "mongoose";
import type {
  ReceivedPaymentsReport,
  AgedReceivablesReport,
  AgedItem,
  AgedTotals,
  InvoiceSummaryReport,
  DailyReport,
  DailyReportRow,
  DailyBreakdown,
  DailyBreakdownGroup,
  DailyBreakdownKind,
  DailyBreakdownRecord,
  MadePaymentsReport,
  AgedPayablesReport,
  PLReport,
  PLBasis,
  PLPeriod,
  PLCategory,
  BalanceSheetReport,
  CashFlowReport,
  VATReport,
  SalesByItemReport,
  ExpenseByCategoryReport,
  CustomerStatementReport,
  CustomerStatementLine,
} from "@delta/shared";
import { ENROLMENT_CRM_LABELS, OLD_BOOKS_SOURCE, PAYMENT_METHOD_LABELS, VAT_FREE_METHODS, categoryLabel, enrolmentCrm, formatMoney, paidAmountMinor, paidCurrency, type PaymentMethod } from "@delta/shared";
import type { OtherCurrencyLine } from "@delta/shared";
import { Invoice } from "../invoice/invoice.model";
import { Bill } from "../bill/bill.model";
import { Expense } from "../expense/expense.model";
import { categoryNameMap, pnlExpenseFilter } from "../expense-category/expense-category.service";
import { payrollInPeriod } from "../payroll/payroll-month";
import { User } from "../user/user.model";
import { Department } from "../department/department.model";

// ── Helpers ───────────────────────────────────────────────────────────────────

function oid(id: string) {
  return new Types.ObjectId(id);
}

function dateOnly(d: Date | undefined): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function startOf(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

function endOf(dateStr: string): Date {
  return new Date(`${dateStr}T23:59:59.999Z`);
}

function daysApart(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

function classifyOverdue(daysOverdue: number) {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "band1to30";
  if (daysOverdue <= 60) return "band31to60";
  if (daysOverdue <= 90) return "band61to90";
  return "band90plus";
}

function sumBand(items: AgedItem[]): number {
  return items.reduce((s, i) => s + i.balanceMinor, 0);
}

function emptyAgedTotals(
  current: AgedItem[],
  band1to30: AgedItem[],
  band31to60: AgedItem[],
  band61to90: AgedItem[],
  band90plus: AgedItem[],
): AgedTotals {
  const c = sumBand(current);
  const b1 = sumBand(band1to30);
  const b2 = sumBand(band31to60);
  const b3 = sumBand(band61to90);
  const b4 = sumBand(band90plus);
  return { current: c, band1to30: b1, band31to60: b2, band61to90: b3, band90plus: b4, grand: c + b1 + b2 + b3 + b4 };
}

// ── 8.1a Received Payments ────────────────────────────────────────────────────

/**
 * Keeps another currency's money out of a report's figures (the user, 2026-11-26: "fix the same currency mixing in the
 * dashboard and the other reports too"). Every report here added amounts whatever their currency — an invoice, a bill
 * or an expense in rupees went into a dirham total as dirhams. `own` says whether an amount is in the organization's
 * own currency (one with none on it is); if it is not, the amount is noted apart under the figure it would have gone
 * into, as recorded, and the caller leaves it out. `lines` is what the report carries: a line per currency and figure.
 */
export function apart(base: string) {
  const by = new Map<string, OtherCurrencyLine>();
  return {
    own(currency: unknown, amountMinor: number, what: string, count = 1): boolean {
      const c = String(currency || base).toUpperCase();
      if (c === base) return true;
      const key = `${c}|${what}`;
      const line = by.get(key) ?? { currency: c, what, amountMinor: 0, count: 0 };
      line.amountMinor += amountMinor;
      line.count += count;
      by.set(key, line);
      return false;
    },
    lines(): { otherCurrencies?: OtherCurrencyLine[] } {
      const list = [...by.values()].sort((a, b) => a.currency.localeCompare(b.currency) || a.what.localeCompare(b.what));
      return list.length ? { otherCurrencies: list } : {};
    },
  };
}

export async function getReceivedPayments(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<ReceivedPaymentsReport> {
  const fromDate = startOf(from);
  const toDate = endOf(to);

  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    "payments.0": { $exists: true },
  })
    .select("payments currency")
    .lean();

  const other = apart(await baseCurrencyOf(orgId));
  let totalMinor = 0;
  const byPeriodMap = new Map<string, number>();

  for (const inv of invoices) {
    const payments = (inv as unknown as { payments: { amountMinor: number; paidOn: Date }[] }).payments ?? [];
    for (const p of payments) {
      const paidOn = new Date(p.paidOn);
      if (paidOn >= fromDate && paidOn <= toDate) {
        if (!other.own((inv as unknown as { currency?: string }).currency, p.amountMinor, "Payments received")) continue;
        totalMinor += p.amountMinor;
        const key = dateOnly(paidOn).slice(0, 7); // YYYY-MM
        byPeriodMap.set(key, (byPeriodMap.get(key) ?? 0) + p.amountMinor);
      }
    }
  }

  const byPeriod = [...byPeriodMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, amountMinor]) => ({ label, amountMinor }));

  return { from, to, currency, totalMinor, byPeriod, ...other.lines() };
}

// ── 8.1b Aged Receivables ─────────────────────────────────────────────────────

export async function getAgedReceivables(
  orgId: string,
  currency = "AED",
): Promise<AgedReceivablesReport> {
  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    status: { $in: ["sent", "viewed", "partial", "overdue"] },
    balanceMinor: { $gt: 0 },
  })
    .select("invoiceNumber customerName issueDate dueDate totalMinor balanceMinor currency")
    .lean();

  const other = apart(await baseCurrencyOf(orgId));
  const today = new Date();
  const bands = {
    current: [] as AgedItem[],
    band1to30: [] as AgedItem[],
    band31to60: [] as AgedItem[],
    band61to90: [] as AgedItem[],
    band90plus: [] as AgedItem[],
  };

  for (const inv of invoices) {
    const d = inv as unknown as Record<string, unknown>;
    if (!other.own(d.currency, (d.balanceMinor as number) ?? 0, "Still owed")) continue;
    const dueDate = new Date(d.dueDate as Date);
    const daysOverdue = daysApart(dueDate, today);
    const item: AgedItem = {
      id: (inv as unknown as { _id: Types.ObjectId })._id.toString(),
      number: inv.invoiceNumber,
      partyName: inv.customerName,
      issuedDate: dateOnly(d.issueDate as Date),
      dueDate: dateOnly(dueDate),
      totalMinor: (inv.totalMinor as number) ?? 0,
      balanceMinor: (inv.balanceMinor as number) ?? 0,
      daysOverdue,
    };
    const band = classifyOverdue(daysOverdue);
    bands[band].push(item);
  }

  return {
    asOf: dateOnly(today),
    currency,
    ...bands,
    totals: emptyAgedTotals(bands.current, bands.band1to30, bands.band31to60, bands.band61to90, bands.band90plus),
    ...other.lines(),
  };
}

// ── 8.1c Invoice Summary ──────────────────────────────────────────────────────

export async function getInvoiceSummary(
  orgId: string,
  from: string,
  to: string,
  groupBy: "salesperson" | "customer" | "tag" | "department",
  currency = "AED",
): Promise<InvoiceSummaryReport> {
  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    issueDate: { $gte: startOf(from), $lte: endOf(to) },
    status: { $nin: ["draft", "void"] },
  })
    .select("salespersonId salespersonName customerId customerName tagIds totalMinor balanceMinor amountPaidMinor currency")
    .lean();

  // department grouping: resolve each salesperson's department from their org membership
  const deptBySalesperson = new Map<string, { id: string; name: string }>();
  if (groupBy === "department") {
    const orgObjId = oid(orgId);
    const [users, departments] = await Promise.all([
      User.find({ "memberships.organizationId": orgObjId }).select("memberships").lean(),
      Department.find({ organizationId: orgObjId }).select("name").lean(),
    ]);
    const deptNames = new Map(departments.map((dep) => [dep._id.toString(), dep.name as string]));
    for (const u of users as unknown as { _id: Types.ObjectId; memberships: { organizationId: Types.ObjectId; departmentId?: Types.ObjectId }[] }[]) {
      const m = u.memberships.find((mm) => mm.organizationId.equals(orgObjId));
      const deptId = m?.departmentId?.toString();
      if (deptId && deptNames.has(deptId)) {
        deptBySalesperson.set(u._id.toString(), { id: deptId, name: deptNames.get(deptId)! });
      }
    }
  }

  const groupMap = new Map<string, { id: string; label: string; count: number; totalMinor: number; paidMinor: number; outstandingMinor: number }>();

  const other = apart(await baseCurrencyOf(orgId));
  for (const inv of invoices) {
    const d = inv as unknown as Record<string, unknown>;
    if (!other.own(d.currency, (d.totalMinor as number) ?? 0, "Invoiced")) continue;
    let id: string;
    let label: string;

    if (groupBy === "salesperson") {
      id = String(d.salespersonId);
      label = (d.salespersonName as string) ?? "Unknown";
    } else if (groupBy === "department") {
      const dept = deptBySalesperson.get(String(d.salespersonId));
      id = dept?.id ?? "__none";
      label = dept?.name ?? "No Department";
    } else if (groupBy === "customer") {
      id = String(d.customerId);
      label = (d.customerName as string) ?? "Unknown";
    } else {
      // tag — one invoice can appear in multiple groups
      const tagIds = (d.tagIds as Types.ObjectId[]) ?? [];
      if (tagIds.length === 0) {
        id = "__untagged";
        label = "Untagged";
      } else {
        for (const tagId of tagIds) {
          const tid = tagId.toString();
          const existing = groupMap.get(tid) ?? { id: tid, label: tid, count: 0, totalMinor: 0, paidMinor: 0, outstandingMinor: 0 };
          existing.count++;
          existing.totalMinor += (inv.totalMinor as number) ?? 0;
          existing.paidMinor += (inv.amountPaidMinor as number) ?? 0;
          existing.outstandingMinor += (inv.balanceMinor as number) ?? 0;
          groupMap.set(tid, existing);
        }
        continue;
      }
    }

    const existing = groupMap.get(id) ?? { id, label, count: 0, totalMinor: 0, paidMinor: 0, outstandingMinor: 0 };
    existing.count++;
    existing.totalMinor += (inv.totalMinor as number) ?? 0;
    existing.paidMinor += (inv.amountPaidMinor as number) ?? 0;
    existing.outstandingMinor += (inv.balanceMinor as number) ?? 0;
    groupMap.set(id, existing);
  }

  return {
    from,
    to,
    currency,
    groupBy,
    items: [...groupMap.values()].sort((a, b) => b.totalMinor - a.totalMinor),
    ...other.lines(),
  };
}

// ── 8.1d Daily income / expense / revenue ─────────────────────────────────────

export async function getDailyReport(
  orgId: string,
  from: string,
  to: string,
  departmentId?: string,
  /** Which currency's days and totals (2026-11-07); blank: the organization's. */
  want = "",
): Promise<DailyReport> {
  const fromDate = startOf(from);
  const toDate = endOf(to);
  const base = await baseCurrencyOf(orgId);

  // Optional department scope: invoices whose salesperson belongs to it.
  const salespersonFilter = await departmentSalespeople(orgId, departmentId);

  // Per currency, never added together (the user, 2026-11-07: an INR expense counted as AED).
  const byCur = new Map<string, Map<string, DailyReportRow>>();
  const row = (cur: string, date: string): DailyReportRow => {
    const c = String(cur || base).toUpperCase();
    let days = byCur.get(c);
    if (!days) byCur.set(c, (days = new Map()));
    let r = days.get(date);
    if (!r) {
      r = { date, incomeMinor: 0, expenseMinor: 0, revenueMinor: 0, netMinor: 0 };
      days.set(date, r);
    }
    return r;
  };

  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    status: { $nin: ["draft", "void"] },
  })
    .select("salespersonId issueDate totalMinor currency payments")
    .lean();
  const other = new Map<string, { currency: string; amountMinor: number; recordedMinor: number }>();
  const notRecorded = { count: 0, amountMinor: 0 };

  for (const inv of invoices) {
    const d = inv as unknown as {
      salespersonId?: Types.ObjectId;
      issueDate?: Date;
      totalMinor?: number;
      currency?: string;
      payments?: { amountMinor: number; paidOn: Date; method?: string; original?: { currency?: string; amountMinor?: number }; bankCurrency?: string; bankAmountMinor?: number }[];
    };
    if (salespersonFilter && !salespersonFilter.has(String(d.salespersonId))) continue;

    if (d.issueDate) {
      const issued = new Date(d.issueDate);
      if (issued >= fromDate && issued <= toDate) {
        row(d.currency ?? base, dateOnly(issued)).revenueMinor += d.totalMinor ?? 0;
      }
    }
    for (const p of d.payments ?? []) {
      const paidOn = new Date(p.paidOn);
      if (paidOn >= fromDate && paidOn <= toDate) {
        // Paid in another currency: income in that currency, as it was paid — never what it was converted to (the
        // user, 2026-11-13). One whose amount was never recorded stays where it was recorded, counted for the note.
        const paidIn = paidCurrency(p, d.currency ?? base), paid = paidAmountMinor(p, d.currency ?? base);
        if (paidIn && paid > 0) {
          row(paidIn, dateOnly(paidOn)).incomeMinor += paid;
          const line = other.get(paidIn) ?? { currency: paidIn, amountMinor: 0, recordedMinor: 0 };
          line.amountMinor += paid;
          line.recordedMinor += p.amountMinor ?? 0;
          other.set(paidIn, line);
          continue;
        }
        if (paidIn) {
          notRecorded.count++;
          notRecorded.amountMinor += p.amountMinor ?? 0;
        }
        row(d.currency ?? base, dateOnly(paidOn)).incomeMinor += p.amountMinor ?? 0;
      }
    }
  }

  // Expenses carry no department, so they are always org-wide — and only those counting in the P&L.
  const expenses = await Expense.find({
    organizationId: oid(orgId),
    expenseDate: { $gte: fromDate, $lte: toDate },
    status: { $in: ["approved", "submitted"] },
    // Not a bill's own expense (2026-10-23): this report has never counted bills, and still doesn't.
    "source.kind": { $ne: "bill" },
    ...(await pnlExpenseFilter(orgId)),
  })
    .select("expenseDate totalMinor currency")
    .lean();

  for (const e of expenses as unknown as { expenseDate: Date; totalMinor?: number; currency?: string }[]) {
    row(e.currency ?? base, dateOnly(new Date(e.expenseDate))).expenseMinor += e.totalMinor ?? 0;
  }

  const rowsOf = (c: string) => [...(byCur.get(c)?.values() ?? [])]
    .map((r) => ({ ...r, netMinor: r.incomeMinor - r.expenseMinor }))
    .sort((a, b) => b.date.localeCompare(a.date));
  const totalsOf = (rows: DailyReportRow[]) => rows.reduce(
    (acc, r) => {
      acc.incomeMinor += r.incomeMinor;
      acc.expenseMinor += r.expenseMinor;
      acc.revenueMinor += r.revenueMinor;
      acc.netMinor += r.netMinor;
      return acc;
    },
    { incomeMinor: 0, expenseMinor: 0, revenueMinor: 0, netMinor: 0 },
  );
  const counted = new Map([...byCur.entries()].map(([c, days]) => [c, days.size]));
  const currencies = [...byCur.keys()].sort((a, b) => (a === base ? -1 : b === base ? 1 : (counted.get(b)! - counted.get(a)!) || a.localeCompare(b)));
  const currency = currencies.includes(want.toUpperCase()) ? want.toUpperCase() : currencies.includes(base) ? base : currencies[0] ?? base;
  const rows = rowsOf(currency);
  const totals = totalsOf(rows);
  const byCurrency = currencies.map((c) => ({ currency: c, ...totalsOf(rowsOf(c)) }));

  return {
    from, to, currency, departmentId: departmentId ?? null, rows, totals, currencies, byCurrency,
    ...(other.size || notRecorded.count
      ? { otherCurrencyIncome: { lines: [...other.values()].sort((a, b) => b.recordedMinor - a.recordedMinor), notRecordedCount: notRecorded.count, notRecordedMinor: notRecorded.amountMinor } }
      : {}),
  };
}

/** The organization's own currency. */
export async function baseCurrencyOf(orgId: string): Promise<string> {
  const { Organization } = await import("../organization/organization.model");
  const org = await Organization.findById(orgId).select("baseCurrency").lean<{ baseCurrency?: string } | null>();
  return String(org?.baseCurrency ?? "AED").toUpperCase();
}

/** The salespeople of a department — the Daily Report's department scope for income and revenue; null for all. */
async function departmentSalespeople(orgId: string, departmentId?: string): Promise<Set<string> | null> {
  if (!departmentId) return null;
  const users = await User.find({
    memberships: { $elemMatch: { organizationId: oid(orgId), departmentId: oid(departmentId) } },
  })
    .select("_id")
    .lean();
  return new Set(users.map((u) => u._id.toString()));
}

const DAILY_GROUPS: Record<DailyBreakdownKind, Array<{ key: string; label: string }>> = {
  income: [{ key: "method", label: "Payment method" }, { key: "salesperson", label: "Salesperson" }, { key: "crm", label: "CRM" }],
  revenue: [{ key: "salesperson", label: "Salesperson" }, { key: "crm", label: "CRM" }],
  expense: [{ key: "category", label: "Category" }, { key: "subcategory", label: "Subcategory" }, { key: "department", label: "Department" }, { key: "submittedBy", label: "Submitted by" }, { key: "status", label: "Status" }],
};

/** Which CRM an invoice came from — or typed in finance. */
export function crmOf(inv: any): string {
  const crm = enrolmentCrm(inv.enrolment?.crm, inv.external?.source);
  if (crm) return ENROLMENT_CRM_LABELS[crm];
  if (inv.external?.source === OLD_BOOKS_SOURCE) return "Old books";
  return inv.external?.source ? String(inv.external.source) : "Typed in finance";
}

/**
 * The records behind a Daily Report figure — income, expenses or revenue over from..to (one day, or the report's
 * range), with the department scope — by exactly getDailyReport's rules, so they add up to it; grouped.
 */
export async function getDailyBreakdown(
  orgId: string,
  kind: DailyBreakdownKind,
  from: string,
  to: string,
  departmentId?: string,
  /** Which currency's records (2026-11-07); blank: the organization's. */
  want = "",
): Promise<DailyBreakdown> {
  const fromDate = startOf(from);
  const toDate = endOf(to);
  const base = await baseCurrencyOf(orgId);
  const records: DailyBreakdownRecord[] = [];

  if (kind === "income" || kind === "revenue") {
    const salespersonFilter = await departmentSalespeople(orgId, departmentId);
    const invoices = await Invoice.find({ organizationId: oid(orgId), status: { $nin: ["draft", "void"] } })
      .select("invoiceNumber customerName salespersonId salespersonName issueDate totalMinor currency payments enrolment.crm external.source")
      .lean();
    for (const inv of invoices as any[]) {
      if (salespersonFilter && !salespersonFilter.has(String(inv.salespersonId))) continue;
      const crm = crmOf(inv);
      const salesperson = inv.salespersonName || "—";
      if (kind === "revenue") {
        if (!inv.issueDate) continue;
        const issued = new Date(inv.issueDate);
        if (issued < fromDate || issued > toDate) continue;
        records.push({
          id: String(inv._id), date: dateOnly(issued), number: inv.invoiceNumber, title: inv.customerName ?? "", detail: salesperson,
          amountMinor: inv.totalMinor ?? 0, currency: inv.currency ?? "AED", href: `/invoices/${inv._id}`, groups: { salesperson, crm },
        });
        continue;
      }
      for (const p of inv.payments ?? []) {
        const paidOn = new Date(p.paidOn);
        if (paidOn < fromDate || paidOn > toDate) continue;
        const method = PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? String(p.method ?? "—");
        // As the report: a payment in another currency as it was paid, under that currency; what it was recorded as
        // is said beside it.
        const paidIn = paidCurrency(p, inv.currency ?? "AED"), paid = paidAmountMinor(p, inv.currency ?? "AED");
        const rupees = paidIn && paid > 0 ? paid : 0;
        records.push({
          id: `${inv._id}:${p._id ?? paidOn.getTime()}`, date: dateOnly(paidOn), number: p.receiptNumber || inv.invoiceNumber,
          title: inv.customerName ?? "",
          detail: [inv.invoiceNumber, method, rupees > 0 ? `recorded as ${formatMoney(p.amountMinor ?? 0, inv.currency ?? "AED")}` : ""].filter(Boolean).join(" · "),
          amountMinor: rupees > 0 ? rupees : p.amountMinor ?? 0, currency: rupees > 0 ? paidIn! : inv.currency ?? "AED", href: `/invoices/${inv._id}`, groups: { method, salesperson, crm },
        });
      }
    }
  } else {
    // As the report: approved and submitted expenses dated in the range, organization-wide, counting in the P&L.
    const expenses = await Expense.find({
      organizationId: oid(orgId),
      expenseDate: { $gte: fromDate, $lte: toDate },
      status: { $in: ["approved", "submitted"] },
      "source.kind": { $ne: "bill" },
      ...(await pnlExpenseFilter(orgId)),
    })
      .select("expenseNumber categoryName subcategoryName description expenseDate totalMinor currency submittedByName status departmentId")
      .populate("departmentId", "name")
      .lean();
    for (const e of expenses as any[]) {
      records.push({
        id: String(e._id), date: dateOnly(new Date(e.expenseDate)), number: e.expenseNumber, title: categoryLabel(e.categoryName, e.subcategoryName) || "Expense",
        detail: e.description ?? "", amountMinor: e.totalMinor ?? 0, currency: e.currency ?? "AED", href: `/expenses/${e._id}`,
        groups: {
          category: e.categoryName || "—",
          subcategory: categoryLabel(e.categoryName, e.subcategoryName) || "—",
          department: (e.departmentId as { name?: string } | null)?.name || "No department",
          submittedBy: e.submittedByName || "—",
          status: e.status === "approved" ? "Approved" : "Waiting for approval",
        },
      });
    }
  }

  // One currency at a time, as the report (2026-11-07): every currency's total for the switch.
  for (const r of records) r.currency = String(r.currency || base).toUpperCase();
  const n = new Map<string, number>();
  for (const r of records) n.set(r.currency, (n.get(r.currency) ?? 0) + 1);
  const currencies = [...n.keys()].sort((a, b) => (a === base ? -1 : b === base ? 1 : (n.get(b)! - n.get(a)!) || a.localeCompare(b)));
  // "ALL": every currency's records at once, each saying its own (the full-day page lists them together and totals
  // each on its own — 2026-11-13); its total and groups are then the organization's currency's, as without it.
  const everything = want.toUpperCase() === "ALL";
  const currency = currencies.includes(want.toUpperCase()) ? want.toUpperCase() : currencies.includes(base) ? base : currencies[0] ?? base;
  const byCurrency = currencies.map((c) => {
    const rs = records.filter((r) => r.currency === c);
    return { currency: c, totalMinor: rs.reduce((t, r) => t + r.amountMinor, 0), count: rs.length };
  });
  const shown = records.filter((r) => r.currency === currency);
  if (everything) records.sort((a, b) => b.date.localeCompare(a.date) || (a.currency === currency ? -1 : b.currency === currency ? 1 : a.currency.localeCompare(b.currency)) || b.amountMinor - a.amountMinor);

  shown.sort((a, b) => b.date.localeCompare(a.date) || b.amountMinor - a.amountMinor);
  const groups: DailyBreakdownGroup[] = DAILY_GROUPS[kind].map(({ key, label }) => {
    const by = new Map<string, { name: string; count: number; amountMinor: number }>();
    for (const r of shown) {
      const name = r.groups[key] ?? "—";
      const g = by.get(name) ?? { name, count: 0, amountMinor: 0 };
      g.count++;
      g.amountMinor += r.amountMinor;
      by.set(name, g);
    }
    return { key, label, items: [...by.values()].sort((a, b) => b.amountMinor - a.amountMinor) };
  });
  return {
    kind, from, to, departmentId: departmentId ?? null, currency,
    totalMinor: shown.reduce((t, r) => t + r.amountMinor, 0), count: shown.length, groups, records: everything ? records : shown,
    currencies, byCurrency,
  };
}

// ── 8.2a Made Payments ────────────────────────────────────────────────────────

export async function getMadePayments(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<MadePaymentsReport> {
  const fromDate = startOf(from);
  const toDate = endOf(to);

  const bills = await Bill.find({
    organizationId: oid(orgId),
    "payments.0": { $exists: true },
  })
    .select("vendorId vendorName payments currency")
    .lean();

  const other = apart(await baseCurrencyOf(orgId));
  let totalMinor = 0;
  const byVendorMap = new Map<string, { vendorId: string; vendorName: string; amountMinor: number }>();

  for (const bill of bills) {
    const d = bill as unknown as Record<string, unknown>;
    const payments = (d.payments as { amountMinor: number; paidOn: Date }[]) ?? [];
    for (const p of payments) {
      const paidOn = new Date(p.paidOn);
      if (paidOn >= fromDate && paidOn <= toDate) {
        if (!other.own(d.currency, p.amountMinor, "Payments made")) continue;
        totalMinor += p.amountMinor;
        const vid = String(d.vendorId);
        const existing = byVendorMap.get(vid) ?? { vendorId: vid, vendorName: (d.vendorName as string) ?? "Unknown", amountMinor: 0 };
        existing.amountMinor += p.amountMinor;
        byVendorMap.set(vid, existing);
      }
    }
  }

  return {
    from,
    to,
    currency,
    totalMinor,
    byVendor: [...byVendorMap.values()].sort((a, b) => b.amountMinor - a.amountMinor),
    ...other.lines(),
  };
}

// ── 8.2b Aged Payables ────────────────────────────────────────────────────────

export async function getAgedPayables(
  orgId: string,
  currency = "AED",
): Promise<AgedPayablesReport> {
  const bills = await Bill.find({
    organizationId: oid(orgId),
    status: { $in: ["approved", "partially_paid", "overdue"] },
    balanceMinor: { $gt: 0 },
  })
    .select("billNumber vendorName billDate dueDate totalMinor balanceMinor currency")
    .lean();

  const other = apart(await baseCurrencyOf(orgId));
  const today = new Date();
  const bands = {
    current: [] as AgedItem[],
    band1to30: [] as AgedItem[],
    band31to60: [] as AgedItem[],
    band61to90: [] as AgedItem[],
    band90plus: [] as AgedItem[],
  };

  for (const bill of bills) {
    const d = bill as unknown as Record<string, unknown>;
    if (!other.own(d.currency, (d.balanceMinor as number) ?? 0, "Still owed")) continue;
    const dueDate = new Date(d.dueDate as Date);
    const daysOverdue = daysApart(dueDate, today);
    const item: AgedItem = {
      id: (bill as unknown as { _id: Types.ObjectId })._id.toString(),
      number: bill.billNumber,
      partyName: bill.vendorName,
      issuedDate: dateOnly(d.billDate as Date),
      dueDate: dateOnly(dueDate),
      totalMinor: (bill.totalMinor as number) ?? 0,
      balanceMinor: (bill.balanceMinor as number) ?? 0,
      daysOverdue,
    };
    const band = classifyOverdue(daysOverdue);
    bands[band].push(item);
  }

  return {
    asOf: dateOnly(today),
    currency,
    ...bands,
    totals: emptyAgedTotals(bands.current, bands.band1to30, bands.band31to60, bands.band61to90, bands.band90plus),
    ...other.lines(),
  };
}

// ── 8.3 Profit & Loss ─────────────────────────────────────────────────────────

/**
 * One period's income, expenses and what is left, in the organization's own currency (`base`).
 *
 * An expense or a supplier bill in another currency is not this currency's money (the user, 2026-11-26: "fix finance's
 * profit and loss so rupee expenses are not added into AED" — every amount was summed whatever its currency, so
 * INR 20,000 went into an AED total as 20,000 dirhams). It is left out of the expenses, their breakdown and the net
 * profit, and given apart, as recorded: a line per currency, never converted — as the Expense report and the Daily
 * Report keep them. One with no currency on it is the organization's.
 */
async function computePL(orgId: string, from: string, to: string, base: string): Promise<PLPeriod> {
  const [invoices, bills, expenses] = await Promise.all([
    Invoice.find({
      organizationId: oid(orgId),
      issueDate: { $gte: startOf(from), $lte: endOf(to) },
      status: { $nin: ["draft", "void"] },
    })
      .select("subtotalMinor currency payments.amountMinor payments.method payments.original payments.bankCurrency payments.bankAmountMinor")
      .lean(),

    Bill.find({
      organizationId: oid(orgId),
      billDate: { $gte: startOf(from), $lte: endOf(to) },
      status: { $nin: ["draft", "voided"] },
    })
      .select("subtotalMinor currency")
      .lean(),

    // Only what counts in the P&L: advances, payroll clearing, VAT, loan principal are recorded but not expenses.
    // Payroll by the month the pay is for, through its run (payroll-month.ts), not by its date (2026-11-27).
    Promise.all([pnlExpenseFilter(orgId), payrollInPeriod(orgId, from, to)]).then(([pnl, payroll]) => Expense.find({
      organizationId: oid(orgId),
      status: { $in: ["approved", "submitted"] },
      $and: [
        // A bill's own expense (2026-10-23): "Supplier bills" counts the bill.
        { $or: [{ expenseDate: { $gte: startOf(from), $lte: endOf(to) }, "source.kind": { $nin: ["bill", "payroll"] } }, payroll.clause] },
        pnl,
      ],
    })
      .select("category totalMinor currency")
      .lean()),
  ]);
  // After the rest, as before: this and the P&L filter above both seed an organization's first categories.
  const nameMap = await categoryNameMap(orgId);

  // An invoice in another currency is not this currency's income either: apart, as recorded.
  const otherIncome = apart(base);
  let incomeTotal = 0;
  for (const inv of invoices) {
    const d = inv as unknown as Record<string, unknown>;
    const amount = (d.subtotalMinor as number) ?? 0;
    if (!otherIncome.own(d.currency, amount, "Invoice revenue")) continue;
    // Paid in another currency on this organization's own invoice (rupees on an AED course — 2026-11-27: "income need
    // to show INR income also separate instead of summing in AED"): that part comes out of the AED income at what it
    // was recorded as — a rupee payment carries no VAT — and is given apart, as paid. One whose amount in that currency
    // was never recorded stays in, as the Collected report keeps it.
    const invCurrency = String(d.currency || base).toUpperCase();
    let away = 0;
    for (const p of (d.payments as any[] | undefined) ?? []) {
      const paidIn = paidCurrency(p, invCurrency);
      const paid = paidIn ? paidAmountMinor(p, invCurrency) : 0;
      if (!paidIn || paid <= 0) continue;
      away += Number(p.amountMinor) || 0;
      otherIncome.own(paidIn, paid, "Invoice revenue");
    }
    incomeTotal += Math.max(0, amount - away);
  }

  // Each currency's supplier bills and expenses by category — the organization's own, and every other one apart.
  type Costs = { bills: number; byCategory: Map<string, number>; count: number };
  const costs = new Map<string, Costs>();
  const costsIn = (currency: unknown): Costs => {
    const key = String(currency || base).toUpperCase();
    const c = costs.get(key) ?? { bills: 0, byCategory: new Map<string, number>(), count: 0 };
    costs.set(key, c);
    return c;
  };
  for (const bill of bills) {
    const d = bill as unknown as Record<string, unknown>;
    const c = costsIn(d.currency);
    c.bills += (d.subtotalMinor as number) ?? 0;
    c.count++;
  }
  for (const exp of expenses) {
    const d = exp as unknown as Record<string, unknown>;
    const c = costsIn(d.currency);
    const cat = (d.category as string) ?? "other";
    c.byCategory.set(cat, (c.byCategory.get(cat) ?? 0) + ((d.totalMinor as number) ?? 0));
    c.count++;
  }
  const breakdownOf = (c: Costs): PLCategory[] => [
    { key: "bills", label: "Supplier bills", amountMinor: c.bills },
    ...[...c.byCategory.entries()].map(([slug, amountMinor]) => ({ key: `cat:${slug}`, label: nameMap.get(slug) ?? slug, amountMinor })),
  ].filter((line) => line.amountMinor > 0);
  const totalOf = (c: Costs) => c.bills + [...c.byCategory.values()].reduce((s, n) => s + n, 0);

  const own = costs.get(base) ?? { bills: 0, byCategory: new Map<string, number>(), count: 0 };
  const totalExpenses = totalOf(own);
  const otherCurrencies = [...costs.entries()]
    .filter(([currency]) => currency !== base)
    .map(([currency, c]) => ({ currency, amountMinor: totalOf(c), count: c.count, breakdown: breakdownOf(c) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    from,
    to,
    income: {
      total: incomeTotal,
      breakdown: [{ key: "income", label: "Invoice revenue", amountMinor: incomeTotal }],
      ...otherIncome.lines(),
    },
    expenses: {
      total: totalExpenses,
      breakdown: breakdownOf(own),
      ...(otherCurrencies.length ? { otherCurrencies } : {}),
    },
    netProfitMinor: incomeTotal - totalExpenses,
  };
}

/**
 * The Profit & Loss counted by money that actually moved (the user, 2026-11-27: "show total collected instead of total
 * invoiced", expenses by the day paid) — a cash view beside the invoiced one.
 *
 * Income: every payment received in the period, VAT taken out so it compares with invoiced income (which is before
 * VAT): a payment with its own tax invoice (a pro-forma's) less that tax invoice's VAT; a payment on an ordinary invoice
 * less the invoice's share of VAT (amount × subtotal ÷ total); a VAT-free method (Tabby DGO) as paid. A payment made in
 * another currency than the organization's (rupees on an AED invoice) is apart, as paid, never added in — or, its amount
 * in that currency never recorded, counted as recorded, as the Collected report does.
 *
 * Expenses: supplier-bill payments made in the period (their share before VAT, as the invoiced view counts a bill's
 * subtotal), and profit-and-loss expenses paid in the period. Unpaid ones are not here. Other currencies apart.
 */
async function computeCashPL(orgId: string, from: string, to: string, base: string): Promise<PLPeriod> {
  const range = { $gte: startOf(from), $lte: endOf(to) };
  const lo = range.$gte.getTime(), hi = range.$lte.getTime();
  const within = (d: unknown) => { const t = new Date(d as Date).getTime(); return t >= lo && t <= hi; };
  const [invoices, bills, expenses] = await Promise.all([
    Invoice.find({ organizationId: oid(orgId), status: { $nin: ["draft", "void"] }, payments: { $elemMatch: { paidOn: range } } })
      .select("currency subtotalMinor totalMinor payments.paidOn payments.amountMinor payments.method payments.original payments.bankCurrency payments.bankAmountMinor payments.taxInvoice")
      .lean(),
    Bill.find({ organizationId: oid(orgId), status: { $nin: ["draft", "voided"] }, payments: { $elemMatch: { paidOn: range } } })
      .select("currency subtotalMinor totalMinor payments.paidOn payments.amountMinor")
      .lean(),
    Promise.all([pnlExpenseFilter(orgId), payrollInPeriod(orgId, from, to)]).then(([pnl, payroll]) => Expense.find({
      organizationId: oid(orgId),
      status: { $in: ["approved", "submitted"] },
      // Paid in the period — payroll by the month the pay is for, through its run, once paid (2026-11-27).
      $and: [
        { $or: [{ paidOn: range, "source.kind": { $nin: ["bill", "payroll"] } }, { ...payroll.clause, paidOn: { $ne: null } }] },
        pnl,
      ],
    }).select("category totalMinor currency").lean()),
  ]);
  const nameMap = await categoryNameMap(orgId);

  const otherIncome = apart(base);
  let received = 0, vatOut = 0;
  for (const doc of invoices) {
    const inv = doc as unknown as { currency?: string; subtotalMinor?: number; totalMinor?: number; payments?: any[] };
    const invCurrency = String(inv.currency || base).toUpperCase();
    const total = Number(inv.totalMinor) || 0, subtotal = Number(inv.subtotalMinor) || 0;
    for (const p of inv.payments ?? []) {
      if (!within(p.paidOn)) continue;
      const amount = Number(p.amountMinor) || 0;
      const paidIn = paidCurrency(p, invCurrency);
      const paid = paidIn ? paidAmountMinor(p, invCurrency) : 0;
      if (paidIn && paid > 0) { otherIncome.own(paidIn, paid, "Payments received"); continue; }
      if (!otherIncome.own(invCurrency, amount, "Payments received")) continue;
      const vat = p.taxInvoice?.number ? Number(p.taxInvoice.taxMinor) || 0
        : VAT_FREE_METHODS.includes(String(p.method)) || total <= 0 ? 0
        : amount - Math.round((amount * subtotal) / total);
      received += amount;
      vatOut += vat;
    }
  }
  const incomeTotal = received - vatOut;

  type Costs = { bills: number; byCategory: Map<string, number>; count: number };
  const costs = new Map<string, Costs>();
  const costsIn = (currency: unknown): Costs => {
    const key = String(currency || base).toUpperCase();
    const c = costs.get(key) ?? { bills: 0, byCategory: new Map<string, number>(), count: 0 };
    costs.set(key, c);
    return c;
  };
  for (const doc of bills) {
    const bill = doc as unknown as { currency?: string; subtotalMinor?: number; totalMinor?: number; payments?: any[] };
    const total = Number(bill.totalMinor) || 0, subtotal = Number(bill.subtotalMinor) || 0;
    for (const p of bill.payments ?? []) {
      if (!within(p.paidOn)) continue;
      const amount = Number(p.amountMinor) || 0;
      const c = costsIn(bill.currency);
      c.bills += total > 0 ? Math.round((amount * subtotal) / total) : amount;
      c.count++;
    }
  }
  for (const exp of expenses) {
    const d = exp as unknown as Record<string, unknown>;
    const c = costsIn(d.currency);
    const cat = (d.category as string) ?? "other";
    c.byCategory.set(cat, (c.byCategory.get(cat) ?? 0) + ((d.totalMinor as number) ?? 0));
    c.count++;
  }
  const breakdownOf = (c: Costs): PLCategory[] => [
    { key: "bills", label: "Supplier bills paid", amountMinor: c.bills },
    ...[...c.byCategory.entries()].map(([slug, amountMinor]) => ({ key: `cat:${slug}`, label: nameMap.get(slug) ?? slug, amountMinor })),
  ].filter((line) => line.amountMinor > 0);
  const totalOf = (c: Costs) => c.bills + [...c.byCategory.values()].reduce((sum, n) => sum + n, 0);
  const own = costs.get(base) ?? { bills: 0, byCategory: new Map<string, number>(), count: 0 };
  const totalExpenses = totalOf(own);
  const otherCurrencies = [...costs.entries()]
    .filter(([currency]) => currency !== base)
    .map(([currency, c]) => ({ currency, amountMinor: totalOf(c), count: c.count, breakdown: breakdownOf(c) }))
    .sort((a, b) => a.currency.localeCompare(b.currency));

  return {
    from,
    to,
    income: {
      total: incomeTotal,
      breakdown: [
        { key: "income", label: "Payments received", amountMinor: received },
        { key: "income", label: "Less VAT on them", amountMinor: -vatOut },
      ],
      ...otherIncome.lines(),
    },
    expenses: { total: totalExpenses, breakdown: breakdownOf(own), ...(otherCurrencies.length ? { otherCurrencies } : {}) },
    netProfitMinor: incomeTotal - totalExpenses,
  };
}

/**
 * The records behind one Profit & Loss line (the user, 2026-11-27: "each line will be break down also popup"), counted
 * by exactly the rules of computePL / computeCashPL, so they add up to the line: `line` is a breakdown item's key —
 * "income", "bills", "cat:<category>" — or "expenses" for every expense row. In the organization's own currency only:
 * what is in another is apart on the P&L itself.
 */
export type PLLineRow = {
  id: string; date: string; number: string; title: string; detail: string; amountMinor: number; currency: string; href: string;
  kind: "invoice" | "payment" | "bill" | "bill payment" | "expense";
  grossMinor?: number; vatMinor?: number;
  crm?: string; salesperson?: string; category?: string; subcategory?: string; department?: string; method?: string; employee?: string; month: string;
};

export async function profitLossLines(orgId: string, from: string, to: string, basis: PLBasis, line: string): Promise<{ currency: string; rows: PLLineRow[]; totalMinor: number }> {
  const base = await baseCurrencyOf(orgId);
  const range = { $gte: startOf(from), $lte: endOf(to) };
  const lo = range.$gte.getTime(), hi = range.$lte.getTime();
  const within = (d: unknown) => { const t = new Date(d as Date).getTime(); return t >= lo && t <= hi; };
  const day = (d: unknown) => dateOnly(new Date(d as Date));
  const own = (c: unknown) => String(c || base).toUpperCase() === base;
  const rows: PLLineRow[] = [];
  const wantIncome = line === "income";
  const wantBills = line === "bills" || line === "expenses";
  const wantCat = line === "expenses" ? null : line.startsWith("cat:") ? line.slice(4) : undefined;

  if (wantIncome) {
    const SELECT = "invoiceNumber customerName salespersonName issueDate status currency subtotalMinor totalMinor enrolment.crm external.source payments._id payments.paidOn payments.amountMinor payments.method payments.original payments.bankCurrency payments.bankAmountMinor payments.taxInvoice payments.receiptNumber";
    if (basis === "invoiced") {
      const invoices = await Invoice.find({ organizationId: oid(orgId), issueDate: range, status: { $nin: ["draft", "void"] } }).select(SELECT).lean<any[]>();
      for (const inv of invoices) {
        if (!own(inv.currency)) continue;
        const invCurrency = String(inv.currency || base).toUpperCase();
        let away = 0;
        for (const p of inv.payments ?? []) {
          const paidIn = paidCurrency(p, invCurrency);
          if (paidIn && paidAmountMinor(p, invCurrency) > 0) away += Number(p.amountMinor) || 0;
        }
        const date = day(inv.issueDate);
        rows.push({
          id: String(inv._id), date, month: date.slice(0, 7), number: inv.invoiceNumber, title: inv.customerName ?? "", kind: "invoice",
          detail: away ? `Less ${formatMoney(away, invCurrency)} paid in another currency, shown apart` : "",
          amountMinor: Math.max(0, (inv.subtotalMinor ?? 0) - away), grossMinor: inv.totalMinor ?? 0, vatMinor: (inv.totalMinor ?? 0) - (inv.subtotalMinor ?? 0),
          currency: base, href: `/invoices/${inv._id}`, crm: crmOf(inv), salesperson: inv.salespersonName || "No salesperson",
        });
      }
    } else {
      const invoices = await Invoice.find({ organizationId: oid(orgId), status: { $nin: ["draft", "void"] }, payments: { $elemMatch: { paidOn: range } } }).select(SELECT).lean<any[]>();
      for (const inv of invoices) {
        const invCurrency = String(inv.currency || base).toUpperCase();
        if (!own(invCurrency)) continue;
        const total = Number(inv.totalMinor) || 0, subtotal = Number(inv.subtotalMinor) || 0;
        for (const p of inv.payments ?? []) {
          if (!within(p.paidOn)) continue;
          const paidIn = paidCurrency(p, invCurrency);
          if (paidIn && paidAmountMinor(p, invCurrency) > 0) continue;
          const amount = Number(p.amountMinor) || 0;
          const vat = p.taxInvoice?.number ? Number(p.taxInvoice.taxMinor) || 0
            : VAT_FREE_METHODS.includes(String(p.method)) || total <= 0 ? 0
            : amount - Math.round((amount * subtotal) / total);
          const date = day(p.paidOn);
          rows.push({
            id: `${inv._id}:${p._id}`, date, month: date.slice(0, 7), number: p.taxInvoice?.number || p.receiptNumber || inv.invoiceNumber, title: inv.customerName ?? "", kind: "payment",
            detail: `Towards ${inv.invoiceNumber}`, amountMinor: amount - vat, grossMinor: amount, vatMinor: vat, currency: base, href: `/invoices/${inv._id}`,
            crm: crmOf(inv), salesperson: inv.salespersonName || "No salesperson", method: PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? String(p.method ?? ""),
          });
        }
      }
    }
  }

  if (wantBills) {
    const bills = await Bill.find(basis === "invoiced"
      ? { organizationId: oid(orgId), billDate: range, status: { $nin: ["draft", "voided"] } }
      : { organizationId: oid(orgId), status: { $nin: ["draft", "voided"] }, payments: { $elemMatch: { paidOn: range } } })
      .select("billNumber vendorName billDate currency subtotalMinor totalMinor payments._id payments.paidOn payments.amountMinor payments.method").lean<any[]>();
    for (const b of bills) {
      if (!own(b.currency)) continue;
      const total = Number(b.totalMinor) || 0, subtotal = Number(b.subtotalMinor) || 0;
      if (basis === "invoiced") {
        const date = day(b.billDate);
        rows.push({ id: String(b._id), date, month: date.slice(0, 7), number: b.billNumber, title: b.vendorName ?? "", detail: "Supplier bill", kind: "bill", amountMinor: subtotal, grossMinor: total, vatMinor: total - subtotal, currency: base, href: `/bills/${b._id}`, category: "Supplier bills" });
        continue;
      }
      for (const p of b.payments ?? []) {
        if (!within(p.paidOn)) continue;
        const amount = Number(p.amountMinor) || 0;
        const share = total > 0 ? Math.round((amount * subtotal) / total) : amount;
        const date = day(p.paidOn);
        rows.push({ id: `${b._id}:${p._id}`, date, month: date.slice(0, 7), number: b.billNumber, title: b.vendorName ?? "", detail: "Supplier bill payment", kind: "bill payment", amountMinor: share, grossMinor: amount, vatMinor: amount - share, currency: base, href: `/bills/${b._id}`, category: "Supplier bills", method: PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? String(p.method ?? "") });
      }
    }
  }

  if (wantCat !== undefined) {
    const [pnl, payroll] = await Promise.all([pnlExpenseFilter(orgId), payrollInPeriod(orgId, from, to)]);
    const when = basis === "invoiced"
      ? { $or: [{ expenseDate: range, "source.kind": { $nin: ["bill", "payroll"] } }, payroll.clause] }
      : { $or: [{ paidOn: range, "source.kind": { $nin: ["bill", "payroll"] } }, { ...payroll.clause, paidOn: { $ne: null } }] };
    const [expenses, nameMap, depts] = await Promise.all([
      Expense.find({ organizationId: oid(orgId), status: { $in: ["approved", "submitted"] }, ...(wantCat ? { category: wantCat } : {}), $and: [when, pnl] })
        .select("expenseNumber category subcategoryName description expenseDate paidOn totalMinor currency departmentId paymentMethod submittedByName source.kind source.key").lean<any[]>(),
      categoryNameMap(orgId),
      Department.find({ organizationId: oid(orgId) }).select("name").lean<any[]>(),
    ]);
    const deptName = new Map(depts.map((x) => [String(x._id), x.name]));
    for (const e of expenses) {
      if (!own(e.currency)) continue;
      // Shown on its own date (paid date when collected); payroll is in the month the pay is for, and says so.
      const isPayroll = e.source?.kind === "payroll";
      const date = day(basis === "collected" || isPayroll ? (e.paidOn ?? e.expenseDate) : e.expenseDate);
      const payMonth = isPayroll ? payroll.month(e.source?.key) : "";
      rows.push({
        id: String(e._id), date, month: payMonth || date.slice(0, 7), number: e.expenseNumber ?? "", title: e.description || (nameMap.get(e.category) ?? e.category), kind: "expense",
        detail: isPayroll ? `Payroll for ${payMonth || "—"}, paid ${e.paidOn ? day(e.paidOn) : "—"}` : "", amountMinor: e.totalMinor ?? 0, currency: base, href: `/expenses/${e._id}`,
        category: nameMap.get(e.category) ?? e.category, subcategory: e.subcategoryName || "—", department: (e.departmentId && deptName.get(String(e.departmentId))) || "No department",
        method: e.paymentMethod ? (PAYMENT_METHOD_LABELS[e.paymentMethod as PaymentMethod] ?? String(e.paymentMethod)) : "", employee: e.submittedByName || "",
      });
    }
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || b.amountMinor - a.amountMinor);
  return { currency: base, rows, totalMinor: rows.reduce((n, r) => n + r.amountMinor, 0) };
}
/** What is still owed on the invoices issued in the period, in the organization's currency — beside the two bases. */
async function owedOnPeriodInvoices(orgId: string, from: string, to: string, base: string): Promise<number> {
  const rows = await Invoice.find({ organizationId: oid(orgId), issueDate: { $gte: startOf(from), $lte: endOf(to) }, status: { $nin: ["draft", "void"] }, balanceMinor: { $gt: 0 } })
    .select("currency balanceMinor").lean();
  return rows.reduce((sum, r) => (String((r as any).currency || base).toUpperCase() === base ? sum + ((r as any).balanceMinor ?? 0) : sum), 0);
}

/** One period's Profit & Loss on either basis, nothing else worked out — for a month-by-month series (Root, 2026-11-27). */
export async function profitLossPeriod(orgId: string, from: string, to: string, basis: PLBasis = "invoiced"): Promise<PLPeriod> {
  const base = await baseCurrencyOf(orgId);
  return (basis === "collected" ? computeCashPL : computePL)(orgId, from, to, base);
}

export async function getProfitLoss(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
  basis: PLBasis = "invoiced",
): Promise<PLReport> {
  const base = await baseCurrencyOf(orgId);
  const compute = basis === "collected" ? computeCashPL : computePL;

  // Prior period: same duration shifted back
  const duration = endOf(to).getTime() - startOf(from).getTime();
  const priorTo = new Date(startOf(from).getTime() - 86_400_000);
  const priorFrom = new Date(priorTo.getTime() - duration);
  // Both bases' income for the strip above the page, whichever is shown.
  const [current, other, prior, owed] = await Promise.all([
    compute(orgId, from, to, base),
    (basis === "collected" ? computePL : computeCashPL)(orgId, from, to, base),
    compute(orgId, dateOnly(priorFrom), dateOnly(priorTo), base),
    owedOnPeriodInvoices(orgId, from, to, base),
  ]);
  const invoiced = basis === "collected" ? other : current;
  const collected = basis === "collected" ? current : other;

  return {
    ...current, currency, basis, prior,
    bases: { invoicedMinor: invoiced.income.total, collectedMinor: collected.income.total, owedMinor: owed },
  };
}

// ── 8.4 Balance Sheet ─────────────────────────────────────────────────────────

export async function getBalanceSheet(
  orgId: string,
  asOf: string,
  currency = "AED",
): Promise<BalanceSheetReport> {
  const asOfDate = endOf(asOf);

  const [receivableAgg, payableAgg] = await Promise.all([
    Invoice.aggregate([
      {
        $match: {
          organizationId: oid(orgId),
          issueDate: { $lte: asOfDate },
          status: { $nin: ["draft", "void"] },
          balanceMinor: { $gt: 0 },
        },
      },
      { $group: { _id: "$currency", total: { $sum: "$balanceMinor" }, count: { $sum: 1 } } },
    ]),
    Bill.aggregate([
      {
        $match: {
          organizationId: oid(orgId),
          billDate: { $lte: asOfDate },
          status: { $nin: ["draft", "voided"] },
          balanceMinor: { $gt: 0 },
        },
      },
      { $group: { _id: "$currency", total: { $sum: "$balanceMinor" }, count: { $sum: 1 } } },
    ]),
  ]);

  // Each currency's balance on its own: the organization's is the figure, the rest are apart.
  const other = apart(await baseCurrencyOf(orgId));
  const ownTotal = (rows: { _id: unknown; total?: number; count?: number }[], what: string) =>
    rows.reduce((sum, r) => (other.own(r._id, r.total ?? 0, what, r.count ?? 1) ? sum + (r.total ?? 0) : sum), 0);
  const ar = ownTotal(receivableAgg, "Accounts receivable");
  const ap = ownTotal(payableAgg, "Accounts payable");

  return {
    asOf,
    currency,
    assets: { accountsReceivable: ar, total: ar },
    liabilities: { accountsPayable: ap, total: ap },
    equity: ar - ap,
    ...other.lines(),
  };
}

// ── 8.5 Cash Flow ─────────────────────────────────────────────────────────────

export async function getCashFlow(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<CashFlowReport> {
  const fromDate = startOf(from);
  const toDate = endOf(to);

  // Inflows: invoice payments received in period
  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    "payments.0": { $exists: true },
  })
    .select("payments currency")
    .lean();

  const other = apart(await baseCurrencyOf(orgId));
  let inflows = 0;
  for (const inv of invoices) {
    const payments = (inv as unknown as { payments: { amountMinor: number; paidOn: Date }[] }).payments ?? [];
    for (const p of payments) {
      const paidOn = new Date(p.paidOn);
      if (paidOn >= fromDate && paidOn <= toDate && other.own((inv as unknown as { currency?: string }).currency, p.amountMinor, "Money in")) inflows += p.amountMinor;
    }
  }

  // Outflows: bill payments + approved expenses in period
  const bills = await Bill.find({
    organizationId: oid(orgId),
    "payments.0": { $exists: true },
  })
    .select("payments currency")
    .lean();

  let billOutflows = 0;
  for (const bill of bills) {
    const payments = (bill as unknown as { payments: { amountMinor: number; paidOn: Date }[] }).payments ?? [];
    for (const p of payments) {
      const paidOn = new Date(p.paidOn);
      if (paidOn >= fromDate && paidOn <= toDate && other.own((bill as unknown as { currency?: string }).currency, p.amountMinor, "Money out")) billOutflows += p.amountMinor;
    }
  }

  const expenseAgg = await Expense.aggregate([
    {
      $match: {
        organizationId: oid(orgId),
        expenseDate: { $gte: fromDate, $lte: toDate },
        status: { $in: ["approved", "submitted"] },
        // A bill's own expense (2026-10-23): its payments are counted with the bills.
        "source.kind": { $ne: "bill" },
      },
    },
    { $group: { _id: "$currency", total: { $sum: "$totalMinor" }, count: { $sum: 1 } } },
  ]);
  const expenseOutflows = (expenseAgg as { _id: unknown; total?: number; count?: number }[])
    .reduce((sum, r) => (other.own(r._id, r.total ?? 0, "Money out", r.count ?? 1) ? sum + (r.total ?? 0) : sum), 0);

  const outflows = billOutflows + expenseOutflows;

  return {
    from,
    to,
    currency,
    operating: { inflows, outflows, net: inflows - outflows },
    investing: { net: 0 },
    financing: { net: 0 },
    netChange: inflows - outflows,
    ...other.lines(),
  };
}

// ── 8.6 VAT Report ────────────────────────────────────────────────────────────

/**
 * The VAT charged in a period, one entry per tax invoice: each invoice by its date — but a pro-forma (VAT on payments
 * received, invoice/payment-tax-invoice.ts) is not a tax invoice, so instead each payment's tax invoice, by the day it
 * was paid.
 */
async function outputTax(orgId: string, from: string, to: string): Promise<{ taxTotalMinor: number; taxBreakdown: { code: string; amountMinor: number }[] }[]> {
  const range = { $gte: startOf(from), $lte: endOf(to) };
  const [invoices, proformas] = await Promise.all([
    Invoice.find({
      organizationId: oid(orgId),
      issueDate: range,
      status: { $nin: ["draft", "void"] },
      "proforma.at": { $exists: false },
    }).select("taxTotalMinor taxBreakdown").lean(),
    Invoice.find({
      organizationId: oid(orgId),
      status: { $nin: ["draft", "void"] },
      "proforma.at": { $exists: true },
      payments: { $elemMatch: { paidOn: range, "taxInvoice.number": { $exists: true } } },
    }).select("taxBreakdown payments.paidOn payments.taxInvoice").lean(),
  ]);
  const out = invoices.map((i) => ({
    taxTotalMinor: (i.taxTotalMinor as number) ?? 0,
    taxBreakdown: (i as unknown as { taxBreakdown?: { code: string; amountMinor: number }[] }).taxBreakdown ?? [],
  }));
  const lo = range.$gte.getTime(), hi = range.$lte.getTime();
  for (const inv of proformas) {
    const code = (inv as unknown as { taxBreakdown?: { code: string }[] }).taxBreakdown?.[0]?.code ?? "VAT";
    for (const p of (inv as unknown as { payments?: { paidOn: Date; taxInvoice?: { number?: string; taxMinor?: number } }[] }).payments ?? []) {
      const at = new Date(p.paidOn).getTime();
      if (!p.taxInvoice?.number || at < lo || at > hi) continue;
      const t = p.taxInvoice.taxMinor ?? 0;
      out.push({ taxTotalMinor: t, taxBreakdown: t ? [{ code, amountMinor: t }] : [] });
    }
  }
  return out;
}

export async function getVATReport(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<VATReport> {
  const [tax, bills] = await Promise.all([
    outputTax(orgId, from, to),

    Bill.find({
      organizationId: oid(orgId),
      billDate: { $gte: startOf(from), $lte: endOf(to) },
      status: { $nin: ["draft", "voided"] },
    })
      .select("taxTotalMinor lineItems")
      .lean(),
  ]);

  const invoices = tax;
  const outputTaxMinor = invoices.reduce((s, i) => s + ((i.taxTotalMinor as number) ?? 0), 0);
  const inputTaxMinor = bills.reduce((s, b) => s + ((b.taxTotalMinor as number) ?? 0), 0);

  // Breakdown rows keyed by code (output, from invoices) and by rate (input,
  // from bills — bills carry a per-line taxPct but no tax code). Both sides are
  // included so the breakdown reconciles with the output/input totals.
  const byKey = new Map<string, { code: string; rate: number; outputMinor: number; inputMinor: number }>();

  // Output side — invoice taxBreakdown (per code).
  for (const inv of invoices) {
    const breakdown = (inv as unknown as { taxBreakdown?: { code: string; amountMinor: number }[] }).taxBreakdown ?? [];
    for (const tb of breakdown) {
      const k = `out:${tb.code}`;
      const existing = byKey.get(k) ?? { code: tb.code, rate: 0, outputMinor: 0, inputMinor: 0 };
      existing.outputMinor += tb.amountMinor;
      byKey.set(k, existing);
    }
  }

  // Input side — bill line taxes bucketed by rate (percentage).
  for (const bill of bills) {
    const lines = (bill as unknown as {
      lineItems?: { quantity: number; unitPriceMinor: number; discountPct?: number; taxPct?: number }[];
    }).lineItems ?? [];
    for (const l of lines) {
      const rate = l.taxPct ?? 0;
      if (rate <= 0) continue;
      const taxable = Math.round(l.quantity * l.unitPriceMinor * (1 - (l.discountPct ?? 0) / 100));
      const tax = Math.round((taxable * rate) / 100);
      if (tax === 0) continue;
      const k = `in:${rate}`;
      const existing = byKey.get(k) ?? { code: `Input ${rate}%`, rate, outputMinor: 0, inputMinor: 0 };
      existing.inputMinor += tax;
      byKey.set(k, existing);
    }
  }

  return {
    from,
    to,
    currency,
    outputTaxMinor,
    inputTaxMinor,
    netPayableMinor: outputTaxMinor - inputTaxMinor,
    byRate: [...byKey.values()],
  };
}

// ── 8.7a Sales by Item ────────────────────────────────────────────────────────

export async function getSalesByItem(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<SalesByItemReport> {
  const invoices = await Invoice.find({
    organizationId: oid(orgId),
    issueDate: { $gte: startOf(from), $lte: endOf(to) },
    status: { $nin: ["draft", "void"] },
  })
    .select("lineItems currency")
    .lean();

  const itemMap = new Map<string, { description: string; qty: number; revenueMinor: number }>();
  const other = apart(await baseCurrencyOf(orgId));

  for (const inv of invoices) {
    const lines = (inv as unknown as { lineItems: { itemId?: string; description: string; quantity: number; lineSubtotalMinor: number }[] }).lineItems ?? [];
    if (!other.own((inv as unknown as { currency?: string }).currency, lines.reduce((sum, l) => sum + (l.lineSubtotalMinor ?? 0), 0), "Sales")) continue;
    for (const line of lines) {
      const key = line.itemId ?? `__desc:${line.description}`;
      const existing = itemMap.get(key) ?? { description: line.description, qty: 0, revenueMinor: 0 };
      existing.qty += line.quantity;
      existing.revenueMinor += line.lineSubtotalMinor ?? 0;
      itemMap.set(key, existing);
    }
  }

  const items = [...itemMap.entries()]
    .map(([key, val]) => ({
      itemId: key.startsWith("__desc:") ? null : key,
      description: val.description,
      qty: val.qty,
      revenueMinor: val.revenueMinor,
      avgPriceMinor: val.qty > 0 ? Math.round(val.revenueMinor / val.qty) : 0,
    }))
    .sort((a, b) => b.revenueMinor - a.revenueMinor);

  return {
    from,
    to,
    currency,
    items,
    grandTotalMinor: items.reduce((s, i) => s + i.revenueMinor, 0),
    ...other.lines(),
  };
}

// ── 8.7b Expense by Category ──────────────────────────────────────────────────

export async function getExpenseByCategory(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<ExpenseByCategoryReport> {
  // Per category and subcategory (2026-10-21), of what counts in the P&L.
  const agg = await Expense.aggregate([
    {
      $match: {
        organizationId: oid(orgId),
        expenseDate: { $gte: startOf(from), $lte: endOf(to) },
        status: { $in: ["approved", "submitted"] },
        ...(await pnlExpenseFilter(orgId)),
      },
    },
    {
      $group: {
        _id: { c: "$category", s: "$subcategory", cur: "$currency" },
        sub: { $first: "$subcategoryName" },
        count: { $sum: 1 },
        totalMinor: { $sum: "$totalMinor" },
      },
    },
    { $sort: { totalMinor: -1 } },
  ]);

  const nameMap = await categoryNameMap(orgId);
  // The organization's own currency only; a category's rupees are apart, not a second line of dirhams.
  const other = apart(await baseCurrencyOf(orgId));
  type CategoryRow = { _id: { c: string; s: string | null; cur?: string | null }; sub?: string; count: number; totalMinor: number };
  const categories = (agg as CategoryRow[]).filter((a) => other.own(a._id.cur, a.totalMinor, "Expenses", a.count)).map((a) => ({
    category: categoryLabel(nameMap.get(a._id.c) ?? a._id.c, a._id.s ? a.sub || a._id.s : ""),
    count: a.count,
    totalMinor: a.totalMinor,
  }));

  return {
    from,
    to,
    currency,
    categories,
    grandTotalMinor: categories.reduce((s, c) => s + c.totalMinor, 0),
    ...other.lines(),
  };
}

// ── 8.7c Customer Statement ───────────────────────────────────────────────────

export async function getCustomerStatement(
  orgId: string,
  customerId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<CustomerStatementReport> {
  const CreditNote = (await import("../credit-note/credit-note.model")).CreditNote;

  const [invoices, creditNotes, customer] = await Promise.all([
    Invoice.find({
      organizationId: oid(orgId),
      customerId: oid(customerId),
      issueDate: { $gte: startOf(from), $lte: endOf(to) },
      status: { $nin: ["draft", "void"] },
    })
      .select("invoiceNumber issueDate totalMinor amountPaidMinor payments")
      .lean(),

    CreditNote.find({
      organizationId: oid(orgId),
      customerId: oid(customerId),
      status: { $ne: "voided" },
    })
      .select("creditNoteNumber issueDate totalMinor")
      .lean(),

    (await import("../customer/customer.model")).Customer.findOne({
      _id: oid(customerId),
      organizationId: oid(orgId),
    })
      .select("name")
      .lean(),
  ]);

  const lines: CustomerStatementLine[] = [];

  for (const inv of invoices) {
    const d = inv as unknown as Record<string, unknown>;
    const total = (inv.totalMinor as number) ?? 0;
    lines.push({
      date: dateOnly(d.issueDate as Date),
      type: "invoice",
      number: inv.invoiceNumber,
      description: `Invoice ${inv.invoiceNumber}`,
      debitMinor: total,
      creditMinor: 0,
      balanceMinor: 0, // recalculated below
    });

    const payments = (d.payments as { amountMinor: number; paidOn: Date; reference?: string }[]) ?? [];
    for (const p of payments) {
      lines.push({
        date: dateOnly(new Date(p.paidOn)),
        type: "payment",
        number: (p.reference as string) ?? "",
        description: "Payment received",
        debitMinor: 0,
        creditMinor: p.amountMinor,
        balanceMinor: 0,
      });
    }
  }

  for (const cn of creditNotes) {
    const d = cn as unknown as Record<string, unknown>;
    lines.push({
      date: dateOnly(d.issueDate as Date),
      type: "credit_note",
      number: (d.creditNoteNumber as string) ?? "",
      description: `Credit Note ${String(d.creditNoteNumber ?? "")}`,
      debitMinor: 0,
      creditMinor: (d.totalMinor as number) ?? 0,
      balanceMinor: 0,
    });
  }

  lines.sort((a, b) => a.date.localeCompare(b.date));

  // Running balance
  let balance = 0;
  for (const line of lines) {
    balance += line.debitMinor - line.creditMinor;
    line.balanceMinor = balance;
  }

  const cust = customer as unknown as { name: string } | null;

  return {
    from,
    to,
    currency,
    customerId,
    customerName: cust?.name ?? "Unknown",
    openingBalanceMinor: 0,
    closingBalanceMinor: balance,
    lines,
  };
}
