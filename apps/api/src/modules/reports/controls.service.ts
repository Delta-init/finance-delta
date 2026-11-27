import { Types } from "mongoose";
import type { AuthContext } from "../../middleware/auth";
import { approvalList } from "../approvals/approvals.service";
import { LateEntryModel as LateEntry } from "../late-entry/late-entry.model";
import { CreditNote } from "../credit-note/credit-note.model";
import { Invoice } from "../invoice/invoice.model";
import { Bill } from "../bill/bill.model";
import { Expense } from "../expense/expense.model";
import { PayrollRun } from "../payroll/payroll-run.model";
import { payrollMonthEnd } from "../payroll/payroll-month";
import { CrmCommissionPayout } from "../crm-commission/crm-commission-payout.model";
import { CsCommissionPayout } from "../cs-commission/cs-commission-payout.model";
import { BankTransaction } from "../banking/bank-transaction.model";
import { ReconciliationSession } from "../banking/reconciliation.model";
import { Department } from "../department/department.model";
import { categoryNameMap } from "../expense-category/expense-category.service";
import { baseCurrencyOf, getVATReport } from "./reports.service";
import { financialReport, sidesOf, type FPSide, type FPTotal } from "./financial-position.service";
import { reconciliationReport, CUTOVER, type RCRow } from "./reconciliation.service";

/*
 * Financial controls and management oversight (Phase 6, 2026-11-28) — read-only reports for Root's Financial Controls
 * section, built from what earlier phases and finance's own screens already work out, never a second calculation:
 *
 *   approvals  finance's Approvals service (every kind it gathers, pending), plus late entries, draft credit notes and
 *              payroll runs not yet approved — age, who decides, department where the record has one.
 *   risks      Phase 5's exceptions by severity, status, module and age; money at risk = confirmed discrepancies only.
 *   liquidity  Phase 4's cash position and obligations: due-dated apart from undated, potential shortfall.
 *   expenses   Phase 5's expense findings, plus expenses awaiting approval, missing attachments, late-recorded and
 *              outside their month, unusual movements by category.
 *   payroll    runs by stage, people on hold, Phase 5's payroll, commission and advance findings, possible duplicate
 *              commission payments.
 *   vat        finance's VAT report (indicative), missing tax invoices, taxed bills from vendors with no VAT number,
 *              credit notes not in output VAT, documentation gaps.
 *   closing    a readiness checklist per month, each check worked out from records. Readiness only: no period is
 *              closed — finance has no period lock.
 *   audit      only the activity records actually carry; what is not recorded is said so, never made up.
 *   overview   the dashboard figures, each from the reports above.
 *
 * Approved 2026-11-28 (as recommended): an approval is overdue after 3 days; an exception is long-outstanding after
 * 30 days; an unusual movement = a category's month against the average of the 3 before, ≥ 50% and ≥ 5,000 in its
 * currency; potential shortfall = available recorded cash less obligations due within 30 days or with no due date;
 * money at risk = confirmed discrepancies only, each once; the responsible approver is the permission that decides
 * each kind. Nothing here writes, approves, pays or reconciles.
 */

export type FCReport = "overview" | "approvals" | "risks" | "liquidity" | "expenses" | "payroll" | "vat" | "closing" | "audit";
export const FC_REPORTS: FCReport[] = ["overview", "approvals", "risks", "liquidity", "expenses", "payroll", "vat", "closing", "audit"];
export type FCIndicator = { currency: string; key: string; label: string; value: number | null; as: "money" | "count"; report: string; line: string; note?: string };

const OVERDUE_DAYS = 3;
const LONG_DAYS = 30;
const DAY = 86_400_000;
const oid = (id: string) => new Types.ObjectId(id);
const day = (d: unknown) => (d ? new Date(d as Date).toISOString().slice(0, 10) : "");
const cur = (c: unknown, base: string) => String(c || base).toUpperCase();
const age = (from: unknown, today: string) => (from ? Math.max(0, Math.floor((Date.parse(today) - new Date(from as Date).getTime()) / DAY)) : 0);

const APPROVER: Record<string, string> = {
  invoice: "Enrolment approver (invoice:write)", fund_request: "Budget approver (budget:approve)", tetra_deposit: "Deposit approver (tetra_deposit:approve)",
  balance_payment: "Enrolment approver (invoice:write)", course_change: "Enrolment approver (invoice:write)", expense: "Expense approver (expense:approve)",
  bill: "Bill approver (bill:approve)", payroll: "Payroll approver (payroll:approve)", procurement: "Expense approver (expense:approve)",
  salary_advance: "Expense approver (expense:approve)", reimbursement: "Expense approver (expense:approve)", one_time_payment: "Expense approver (expense:approve)",
  hiring: "Expense approver (expense:approve)", late_entry: "Late-entry approver (late_entry:approve)", credit_note: "Whoever issues credit notes (credit_note:write)",
};
const KIND_LABEL: Record<string, string> = {
  invoice: "Enrolment invoices", fund_request: "Fund requests", tetra_deposit: "CS Portal deposits", balance_payment: "Balance payments", course_change: "Course changes",
  expense: "Expenses", bill: "Supplier bills", payroll: "Payroll runs", procurement: "Procurement", salary_advance: "Salary advances", reimbursement: "Reimbursements",
  one_time_payment: "One-time payments", hiring: "Hiring", late_entry: "Late entries", credit_note: "Credit notes (draft)",
};
const AGE_BANDS = [{ key: "a0_3", label: "Up to 3 days" }, { key: "a4_7", label: "4–7 days (overdue)" }, { key: "a8_30", label: "8–30 days (overdue)" }, { key: "a31", label: "Over 30 days (overdue)" }];
const ageBand = (d: number) => (d <= 3 ? "a0_3" : d <= 7 ? "a4_7" : d <= 30 ? "a8_30" : "a31");

function row(base: string, r: Partial<RCRow> & { id: string; date: string; section: string; line: string; amountMinor: number }): RCRow {
  return { number: "", title: "", detail: "", category: "", status: "", currency: base, href: "", ...r, month: (r.date || "").slice(0, 7) } as RCRow;
}

/** Finance's Approvals service read for the whole organization: a reader who may see every kind, nothing decided. */
async function approvalsOf(orgId: string, base: string, today: string, warnings: string[], status: "pending" | "approved" | "rejected" = "pending", range?: { from: string; to: string }) {
  const auth: AuthContext = { userId: "000000000000000000000000", organizationId: orgId, role: "report", permissions: [], isSuperAdmin: true };
  const q = { status, page: 1, pageSize: 5000, ...(range ? { from: new Date(`${range.from}T00:00:00Z`).toISOString(), to: new Date(Date.parse(`${range.to}T00:00:00Z`) + DAY).toISOString() } : {}) } as never;
  const res = await approvalList(auth, q);
  for (const u of res.meta.unavailable) warnings.push(`Approvals not readable: ${u}`);
  return res.rows;
}

// ── FC-02 Approvals ──────────────────────────────────────────────────────────

async function approvalsReport(orgId: string, base: string, today: string, warnings: string[]) {
  const [list, late, drafts, depts] = await Promise.all([
    approvalsOf(orgId, base, today, warnings),
    LateEntry.find({ organizationId: oid(orgId), state: "pending" }).lean<any[]>(),
    CreditNote.find({ organizationId: oid(orgId), status: "draft" }).select("creditNoteNumber customerName totalMinor currency createdAt").lean<any[]>(),
    Department.find({ organizationId: oid(orgId) }).select("name").lean<any[]>(),
  ]);
  const deptName = new Map(depts.map((x) => [String(x._id), x.name as string]));
  // Departments where the record carries one (expenses and fund requests); every other kind: "Not recorded".
  const expenseIds = list.filter((r) => r.type === "expense").map((r) => r.id).filter((x) => Types.ObjectId.isValid(x));
  const expDept = new Map<string, string>((await Expense.find({ _id: { $in: expenseIds } }).select("departmentId").lean<any[]>()).map((e: any) => [String(e._id), e.departmentId ? deptName.get(String(e.departmentId)) ?? "A removed department" : "No department"]));
  const rows: RCRow[] = [];
  const push = (type: string, r: { id: string; at?: string; title: string; detail: string; amountMinor?: number; currency?: string; raisedBy?: string; href: string; dept?: string; stage?: string }) => {
    const sent = r.at || today;
    const waited = age(sent, today);
    rows.push(row(cur(r.currency, base), {
      id: `${type}:${r.id}`, date: day(sent), section: "pending", line: type, amountMinor: r.amountMinor ?? 0, title: r.title, detail: [r.detail, r.raisedBy ? `raised by ${r.raisedBy}` : ""].filter(Boolean).join(" · "),
      category: KIND_LABEL[type] ?? type, status: r.stage ?? "Waiting for a decision", href: r.href, module: KIND_LABEL[type] ?? type, ageDays: waited, band: ageBand(waited),
      action: APPROVER[type] ?? "—", account: r.dept ?? "Not recorded", kind: waited > OVERDUE_DAYS ? "Overdue" : "Within 3 days",
      ...(waited > OVERDUE_DAYS ? { severity: "medium" as const, confidence: "confirmed" as const, exception: "Approval overdue" } : {}),
    }));
  };
  for (const r of list) push(r.type, { id: r.id, at: r.submittedAt ?? r.at, title: r.title, detail: r.subtitle, amountMinor: r.amountMinor, currency: r.currency, raisedBy: r.raisedBy, href: r.href, dept: r.type === "expense" ? expDept.get(r.id) : undefined });
  for (const l of late) push("late_entry", { id: String(l._id), at: l.createdAt, title: `${l.kind.replace(/_/g, " ")} ${l.number || ""}`.trim(), detail: `${l.title ? l.title + " · " : ""}dated ${day(l.date)}${l.previousDate ? ` (was ${day(l.previousDate)})` : ""} — ${l.reason}`, amountMinor: l.amountMinor, currency: l.currency, raisedBy: l.enteredByName, href: "/late-entries" });
  for (const c of drafts) push("credit_note", { id: String(c._id), at: c.createdAt, title: c.creditNoteNumber, detail: `${c.customerName ?? ""} — not issued yet`, amountMinor: c.totalMinor, currency: c.currency, href: `/credit-notes/${c._id}`, stage: "Draft, not issued" });
  const banded = rows.map((r) => ({ ...r, id: `age:${r.id}`, section: "age", line: r.band! }));
  const all = [...rows, ...banded];
  const kinds = Object.keys(KIND_LABEL);
  const sides = sidesOf(all, base, [
    { key: "pending", title: "Waiting for a decision, by kind", lines: kinds.map((k) => ({ key: k, label: KIND_LABEL[k]! })) },
    { key: "age", title: "How long they have waited", lines: AGE_BANDS },
  ], (sum, currency) => {
    const mine = rows.filter((r) => r.currency === currency);
    return [
      { key: "pending", label: `Waiting for a decision: ${mine.length}`, amountMinor: sum("pending"), strong: true },
      { key: "overdue", label: `Overdue (waiting more than ${OVERDUE_DAYS} days): ${mine.filter((r) => (r.ageDays ?? 0) > OVERDUE_DAYS).length}`, amountMinor: mine.filter((r) => (r.ageDays ?? 0) > OVERDUE_DAYS).reduce((n, r) => n + r.amountMinor, 0) },
    ];
  });
  return { rows: all, sides, pending: rows };
}

// ── FC-03 Risks and exceptions ───────────────────────────────────────────────

function risksReport(exceptions: RCRow[], base: string) {
  const rows: RCRow[] = [];
  for (const e of exceptions) {
    rows.push({ ...e, id: `sev:${e.id}`, section: `sev_${e.severity}`, line: e.exception ?? "" });
    rows.push({ ...e, id: `conf:${e.id}`, section: `conf_${e.confidence}`, line: e.module ?? "" });
    if ((e.ageDays ?? 0) > LONG_DAYS) rows.push({ ...e, id: `long:${e.id}`, section: "long", line: e.severity ?? "" });
  }
  const types = [...new Set(exceptions.map((e) => e.exception ?? ""))].sort().map((t) => ({ key: t, label: t }));
  const modules = [...new Set(exceptions.map((e) => e.module ?? ""))].sort().map((m) => ({ key: m, label: m }));
  const sides = sidesOf(rows, base, [
    { key: "sev_critical", title: "Critical — integrity rule broken", lines: types },
    { key: "sev_high", title: "High — material discrepancy to investigate", lines: types },
    { key: "conf_confirmed", title: "Confirmed discrepancies, by module (amounts counted once — the money at risk)", lines: modules },
    { key: "conf_suspected", title: "Suspected, by module (amounts as recorded — not losses, not added in)", lines: modules, showTotal: false },
    { key: "conf_missing", title: "Missing information, by module (amounts as recorded — not added in)", lines: modules, showTotal: false },
    { key: "long", title: `Outstanding more than ${LONG_DAYS} days, by severity`, lines: ["critical", "high", "medium", "low"].map((k) => ({ key: k, label: k[0]!.toUpperCase() + k.slice(1) })), showTotal: false },
  ], (_sum, currency) => {
    const mine = exceptions.filter((e) => e.currency === currency);
    const n = (f: (e: RCRow) => boolean) => mine.filter(f).length;
    return [
      { key: "exposure", label: "Money at risk — confirmed discrepancies only, each counted once", amountMinor: mine.filter((e) => e.confidence === "confirmed").reduce((t, e) => t + Math.abs(e.amountMinor), 0), strong: true },
      { key: "counts", label: `Exceptions: ${mine.length} — critical ${n((e) => e.severity === "critical")}, high ${n((e) => e.severity === "high")}, medium ${n((e) => e.severity === "medium")}, low ${n((e) => e.severity === "low")}; confirmed ${n((e) => e.confidence === "confirmed")}, suspected ${n((e) => e.confidence === "suspected")}, missing information ${n((e) => e.confidence === "missing")}; over ${LONG_DAYS} days ${n((e) => (e.ageDays ?? 0) > LONG_DAYS)}`, amountMinor: 0, noAmount: true } as FPTotal & { noAmount: boolean },
    ];
  });
  return { rows, sides };
}

// ── FC-04 Liquidity ──────────────────────────────────────────────────────────

function liquidityReport(cash: { rows: any[]; sides: FPSide[] }, obl: { rows: any[]; sides: FPSide[] }, base: string, asOf: string) {
  const rows: RCRow[] = [];
  const horizon = Date.parse(`${asOf}T00:00:00Z`) + 30 * DAY;
  for (const r of cash.rows) rows.push({ ...r, id: `cash:${r.id}`, section: r.section === "psp" ? "psp" : "cash", line: r.section === "psp" ? "psp" : r.amountMinor < 0 ? "negative" : r.section, status: r.status });
  for (const r of obl.rows.filter((x: any) => x.section === "obl")) {
    const dated = !!r.due;
    const soon = dated && Date.parse(`${r.due}T00:00:00Z`) <= horizon;
    rows.push({ ...r, id: `obl:${r.id}`, section: dated ? (soon ? "due_soon" : "due_later") : "no_due", line: r.line, status: r.status });
  }
  const oblLines = [{ key: "bills", label: "Supplier bills" }, { key: "salaries", label: "Unpaid salaries" }, { key: "commission", label: "Unpaid commission" }, { key: "expenses", label: "Unpaid approved expenses" }, { key: "reimbursements", label: "Reimbursements payable" }, { key: "loans", label: "Loan principal" }];
  const sides = sidesOf(rows, base, [
    { key: "cash", title: "Recorded cash (system-recorded — none reconciled to a statement unless shown)", lines: [{ key: "bank", label: "Bank accounts" }, { key: "petty", label: "Petty cash" }, { key: "negative", label: "Accounts below zero" }] },
    { key: "psp", title: "Pending PSP settlements (not available yet)", lines: [{ key: "psp", label: "Payment gateways" }] },
    { key: "due_soon", title: "Obligations due within 30 days (recorded due date)", lines: oblLines },
    { key: "no_due", title: "Obligations with no recorded due date (counted as payable now)", lines: oblLines },
    { key: "due_later", title: "Obligations due after 30 days", lines: oblLines },
  ], (sum, currency) => {
    const c = cash.sides.find((s) => s.currency === currency);
    const confirmed = c?.totals.find((t) => t.key === "confirmed");
    const available = sum("cash");
    return [
      { key: "available", label: "Available recorded cash (bank + petty cash)", amountMinor: available, strong: true },
      { key: "confirmed", label: confirmed?.label ?? "Confirmed by a reconciled statement: none", amountMinor: confirmed?.amountMinor ?? 0 },
      { key: "psp", label: "Pending PSP settlements", amountMinor: sum("psp") },
      { key: "near", label: "Obligations due within 30 days or with no due date", amountMinor: sum("due_soon") + sum("no_due") },
      { key: "shortfall", label: "Potential surplus (+) or shortfall (−): available cash − those obligations", amountMinor: available - sum("due_soon") - sum("no_due"), strong: true },
      { key: "overdue_bills", label: "Overdue supplier payments", amountMinor: rows.filter((r) => r.currency === currency && r.line === "bills" && (r.overdueDays ?? 0) > 0).reduce((n, r) => n + r.amountMinor, 0) },
    ];
  });
  return { rows, sides };
}

// ── FC-05 Expenses ───────────────────────────────────────────────────────────

const AUTO_KINDS = ["import", "bill", "payroll", "hrms_advance", "hrms_one_time", "hrms_reimbursement", "psp_settlement"];
async function expensesReport(orgId: string, base: string, from: string, to: string, today: string, rcExpenses: RCRow[], pending: RCRow[]) {
  const rows: RCRow[] = [];
  const lo = Date.parse(`${from}T00:00:00Z`), hi = Date.parse(`${to}T23:59:59.999Z`);
  for (const r of pending.filter((p) => p.line === "expense")) rows.push({ ...r, id: `appr:${r.id}`, section: "approval", line: "waiting" });
  for (const r of rcExpenses) {
    const map: Record<string, [string, string] | undefined> = { references: ["docs", "no_reference"], duplicates: ["integrity", "duplicate"], no_bank: ["integrity", "no_bank"], classification: ["classification", r.line] };
    const m = map[r.section];
    if (m) rows.push({ ...r, id: `rc:${r.id}`, section: m[0], line: m[1] });
  }
  const [expenses, names] = await Promise.all([
    Expense.find({ organizationId: oid(orgId), status: { $in: ["approved", "submitted"] } }).select("expenseNumber category description expenseDate createdAt paidOn totalMinor currency status attachments lateEntry source.kind").lean<any[]>(),
    categoryNameMap(orgId),
  ]);
  for (const e of expenses) {
    const kind = e.source?.kind;
    if (AUTO_KINDS.includes(kind)) continue;
    const c = cur(e.currency, base);
    const t = new Date(e.expenseDate).getTime();
    const common = { title: e.description ?? "", number: e.expenseNumber ?? "", href: `/expenses/${e._id}`, category: names.get(e.category) ?? e.category };
    if (e.status === "approved" && e.paidOn && !(e.attachments ?? []).length && t <= hi) rows.push(row(c, { ...common, id: `att:${e._id}`, date: day(e.expenseDate), section: "docs", line: "no_attachment", amountMinor: Number(e.totalMinor) || 0, status: "No supporting document attached", severity: "low", confidence: "missing", exception: "Expense without a supporting document", module: "Expenses" }));
    const lag = Math.floor((new Date(e.createdAt).getTime() - t) / DAY);
    if (t >= lo && t <= hi && (e.lateEntry || lag > 30)) rows.push(row(c, { ...common, id: `late:${e._id}`, date: day(e.expenseDate), section: "timing", line: "late", amountMinor: Number(e.totalMinor) || 0, status: e.lateEntry ? `Late entry (${e.lateEntry.state ?? "recorded"})` : `Entered ${lag} days after its date` }));
    const monthEnd = Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1);
    if (t >= lo && t <= hi && new Date(e.createdAt).getTime() >= monthEnd) rows.push(row(c, { ...common, id: `prd:${e._id}`, date: day(e.expenseDate), section: "timing", line: "outside_period", amountMinor: Number(e.totalMinor) || 0, status: `Entered ${day(e.createdAt)}, after its month ended` }));
  }
  // Unusual movements: each category's month against the average of the 3 months before it.
  const byCatMonth = new Map<string, number>();
  for (const e of expenses) {
    if (e.source?.kind === "bill" || e.source?.kind === "payroll") continue;
    const k = `${cur(e.currency, base)}|${e.category}|${day(e.expenseDate).slice(0, 7)}`;
    byCatMonth.set(k, (byCatMonth.get(k) ?? 0) + (Number(e.totalMinor) || 0));
  }
  const months: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= to; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d.toISOString().slice(0, 7));
  const cats = new Set([...byCatMonth.keys()].map((k) => k.split("|").slice(0, 2).join("|")));
  for (const ck of cats) {
    const [c, cat] = ck.split("|") as [string, string];
    for (const mo of months) {
      const prev = [1, 2, 3].map((i) => { const d = new Date(`${mo}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i); return byCatMonth.get(`${c}|${cat}|${d.toISOString().slice(0, 7)}`) ?? 0; });
      const avg = Math.round(prev.reduce((a, b) => a + b, 0) / 3);
      const now = byCatMonth.get(`${c}|${cat}|${mo}`) ?? 0;
      const diff = now - avg;
      if (Math.abs(diff) >= 500_000 && avg > 0 && Math.abs(diff) / avg >= 0.5) rows.push(row(c, { id: `mv:${c}:${cat}:${mo}`, date: `${mo}-01`, section: "movements", line: diff > 0 ? "up" : "down", amountMinor: diff, title: names.get(cat) ?? cat, category: names.get(cat) ?? cat, detail: `${mo}: ${(now / 100).toFixed(2)} against an average of ${(avg / 100).toFixed(2)} over the 3 months before (${diff > 0 ? "+" : ""}${Math.round((diff / avg) * 100)}%)`, status: "Unusual movement", href: "/reports/expenses" }));
      else if (Math.abs(diff) >= 500_000 && avg === 0 && now > 0 && prev.every((p) => p === 0) && months.length > 0) rows.push(row(c, { id: `mv:${c}:${cat}:${mo}`, date: `${mo}-01`, section: "movements", line: "new", amountMinor: now, title: names.get(cat) ?? cat, category: names.get(cat) ?? cat, detail: `${mo}: ${(now / 100).toFixed(2)} with nothing in the 3 months before`, status: "New spending", href: "/reports/expenses" }));
    }
  }
  const sides = sidesOf(rows, base, [
    { key: "approval", title: "Expenses awaiting approval", lines: [{ key: "waiting", label: "Waiting" }] },
    { key: "docs", title: "Documentation", lines: [{ key: "no_attachment", label: "Paid, no supporting document attached" }, { key: "no_reference", label: "Paid (not cash), no payment reference" }] },
    { key: "integrity", title: "Integrity (Phase 5)", lines: [{ key: "duplicate", label: "Possible duplicates" }, { key: "no_bank", label: "Paid, no bank transaction" }] },
    { key: "timing", title: "Timing (period)", lines: [{ key: "late", label: "Late-recorded (late entry, or entered over 30 days after its date)" }, { key: "outside_period", label: "Entered after its month had ended" }] },
    { key: "movements", title: "Unusual movements against the 3 months before (≥ 50% and ≥ 5,000)", lines: [{ key: "up", label: "Up" }, { key: "down", label: "Down" }, { key: "new", label: "New spending" }], showTotal: false },
    { key: "classification", title: "Balance-sheet-like categories counted in the P&L (period)", lines: [{ key: "employee_advances", label: "Employee Advances Receivable" }, { key: "vat_control", label: "VAT Control Account" }, { key: "payroll_payable", label: "Payroll Payable / Payroll Clearing" }] },
  ], (sum) => [
    { key: "classification", label: "Balance-sheet-like categories in the P&L (period)", amountMinor: sum("classification"), strong: true },
    { key: "docs", label: "Documentation gaps (no document, no reference)", amountMinor: sum("docs") },
    { key: "waiting", label: "Awaiting approval", amountMinor: sum("approval") },
  ]);
  return { rows, sides };
}

// ── FC-06 Payroll and commission ─────────────────────────────────────────────

async function payrollReport(orgId: string, base: string, today: string, rcPayroll: RCRow[], rcAdvances: RCRow[], owed: RCRow[] = []) {
  const rows: RCRow[] = [];
  // What is owed as of the date (Phase 4's obligations): salaries in approved runs and commission outside payroll.
  for (const r of owed) if (r.section === "obl" && (r.line === "salaries" || r.line === "commission")) rows.push({ ...r, id: `owed:${r.id}`, section: "owed", line: r.line });
  const runs = await PayrollRun.find({ organizationId: oid(orgId) }).select("runNumber period status currency lines._id lines.name lines.currency lines.payableMinor lines.amountPaidMinor lines.status lines.holdReason importedAt approvedAt").lean<any[]>();
  for (const r of runs) {
    const stage = ["imported", "additions"].includes(r.status) ? "awaiting" : r.status === "approved" ? "approved_unpaid" : r.status === "partially_paid" ? "part_paid" : null;
    const byCur = new Map<string, { payable: number; paid: number; held: number }>();
    for (const l of r.lines ?? []) {
      const c = cur(l.currency || r.currency, base);
      const t = byCur.get(c) ?? { payable: 0, paid: 0, held: 0 };
      t.payable += Number(l.payableMinor) || 0; t.paid += Math.min(Number(l.payableMinor) || 0, Number(l.amountPaidMinor) || 0); byCur.set(c, t);
      if (l.status === "on_hold" && ["approved", "partially_paid"].includes(r.status)) {
        t.held++;
        rows.push(row(c, { id: `hold:${r._id}:${l._id}`, date: day(payrollMonthEnd(r.period)), section: "hold", line: "on_hold", amountMinor: (Number(l.payableMinor) || 0) - (Number(l.amountPaidMinor) || 0), title: l.name ?? "", number: r.runNumber, category: `Payroll ${r.period}`, status: l.holdReason || "On hold", href: `/payroll/${r._id}` }));
      }
    }
    if (!stage) continue;
    for (const [c, t] of byCur) rows.push(row(c, { id: `run:${r._id}:${c}`, date: day(stage === "awaiting" ? r.importedAt : payrollMonthEnd(r.period)), section: "runs", line: stage, amountMinor: stage === "awaiting" ? t.payable : t.payable - t.paid, title: r.runNumber, number: r.runNumber, category: `Payroll ${r.period}`, status: stage === "awaiting" ? `Waiting for approval (${r.status})` : stage === "approved_unpaid" ? `Approved, ${t.paid ? "partly" : "nothing"} paid` : "Part paid", detail: `payable ${(t.payable / 100).toFixed(2)}, paid ${(t.paid / 100).toFixed(2)}${t.held ? `, ${t.held} on hold` : ""}`, href: `/payroll/${r._id}`, ageDays: age(r.importedAt, today) }));
  }
  for (const r of rcPayroll) {
    if (r.section === "payments" && r.line === "reversed") rows.push({ ...r, id: `rc:${r.id}`, section: "reversals", line: "reversed" });
    if (r.section === "commission" && (r.line === "earned_unpaid" || r.line === "approved_unpaid")) rows.push({ ...r, id: `rc:${r.id}`, section: "commission", line: "outstanding" });
    if (r.section === "overlap" && (r.line === "named" || r.line === "same_month")) rows.push({ ...r, id: `rc:${r.id}`, section: "commission", line: r.line === "named" ? "verify_named" : "verify_month" });
  }
  // A payout both paid by its own expense and carried by a payroll run would be paid twice (Phase 2A guards it).
  const [crm, cs] = await Promise.all([
    CrmCommissionPayout.find({ organizationId: oid(orgId), expenseId: { $ne: null }, payrollRunId: { $ne: null } }).select("personName month currency amountMinor").lean<any[]>(),
    CsCommissionPayout.find({ organizationId: oid(orgId), expenseId: { $ne: null }, payrollRunId: { $ne: null } }).select("personName lastMonth currency amountMinor").lean<any[]>(),
  ]);
  for (const p of [...crm, ...cs]) rows.push(row(cur(p.currency, base), { id: `dupc:${p._id}`, date: `${p.month ?? p.lastMonth}-01`, section: "commission", line: "paid_twice", amountMinor: Number(p.amountMinor) || 0, title: p.personName ?? "", category: "Paid directly and on a payroll run", status: "Possible duplicate payment", severity: "critical", confidence: "confirmed", exception: "Commission paid twice", module: "Commission", href: "/commissions/crm" }));
  for (const r of rcAdvances) if (r.section === "earlier" || r.line === "unknown") rows.push({ ...r, id: `rc:${r.id}`, section: "advances", line: r.section === "earlier" ? "beyond" : "unknown" });
  const sides = sidesOf(rows, base, [
    { key: "owed", title: "Unpaid as of the date (Phase 4 obligations)", lines: [{ key: "salaries", label: "Unpaid salaries (approved runs)" }, { key: "commission", label: "Unpaid commission (outside payroll)" }] },
    { key: "runs", title: "Payroll runs by stage (outstanding)", lines: [{ key: "awaiting", label: "Waiting for approval (payable)" }, { key: "approved_unpaid", label: "Approved, not fully paid" }, { key: "part_paid", label: "Part paid" }] },
    { key: "hold", title: "People on payment hold (approved runs)", lines: [{ key: "on_hold", label: "On hold" }] },
    { key: "reversals", title: "Payroll payments reversed (period)", lines: [{ key: "reversed", label: "Reversed" }] },
    { key: "commission", title: "Commission", lines: [{ key: "outstanding", label: "Outstanding (earned or approved, not paid, not in payroll)" }, { key: "paid_twice", label: "Possible duplicate payment (paid directly and on a run)" }, { key: "verify_named", label: "Typed commission naming a payee with a payout — verify" }, { key: "verify_month", label: "Typed commission in a month with payouts — verify" }] },
    { key: "advances", title: "Employee advance recovery discrepancies", lines: [{ key: "beyond", label: "Recovered beyond advances recorded in finance" }, { key: "unknown", label: "Historical advances, recoveries not recorded" }] },
  ], (sum) => [
    { key: "owed", label: "Unpaid salaries and commission as of the date", amountMinor: sum("owed"), strong: true },
    { key: "unpaid", label: "Unpaid on approved runs", amountMinor: sum("runs", "approved_unpaid") + sum("runs", "part_paid") },
    { key: "commission", label: "Commission outstanding", amountMinor: sum("commission", "outstanding") },
    { key: "verify", label: "Typed commission to verify", amountMinor: sum("commission", "verify_named") + sum("commission", "verify_month") },
  ]);
  return { rows, sides };
}

// ── FC-07 VAT and compliance ─────────────────────────────────────────────────

async function vatReport(orgId: string, base: string, from: string, to: string, rcExpenses: RCRow[], docRows: RCRow[]) {
  const rows: RCRow[] = [];
  const range = { $gte: new Date(`${from}T00:00:00Z`), $lte: new Date(`${to}T23:59:59.999Z`) };
  const [vat, bills, proformas, notes] = await Promise.all([
    getVATReport(orgId, from, to, base),
    Bill.find({ organizationId: oid(orgId), status: { $nin: ["draft", "voided"] }, taxTotalMinor: { $gt: 0 }, billDate: range }).select("billNumber vendorId vendorName billDate taxTotalMinor currency").populate("vendorId", "vatNumber").lean<any[]>(),
    Invoice.find({ organizationId: oid(orgId), "proforma.at": { $exists: true }, status: { $nin: ["draft", "void"] }, payments: { $elemMatch: { paidOn: range } } }).select("invoiceNumber customerName currency payments._id payments.paidOn payments.amountMinor payments.taxInvoice").lean<any[]>(),
    CreditNote.find({ organizationId: oid(orgId), status: { $in: ["issued", "applied"] }, issuedAt: range }).select("creditNoteNumber customerName taxTotalMinor currency issuedAt").lean<any[]>(),
  ]);
  rows.push(row(base, { id: "vat:out", date: to, section: "vat", line: "output", amountMinor: vat.outputTaxMinor, title: "Output VAT", category: "Output VAT (invoices; pro-formas by tax invoice)", status: "Indicative" }));
  rows.push(row(base, { id: "vat:in", date: to, section: "vat", line: "input", amountMinor: vat.inputTaxMinor, title: "Input VAT", category: "Input VAT (supplier bills less vendor credits)", status: "Indicative" }));
  for (const b of bills) if (!String((b.vendorId as any)?.vatNumber ?? "").trim()) rows.push(row(cur(b.currency, base), { id: `vn:${b._id}`, date: day(b.billDate), section: "gaps", line: "vendor_vat", amountMinor: Number(b.taxTotalMinor) || 0, title: b.vendorName ?? "", number: b.billNumber, category: "VAT claimed on a bill from a vendor with no VAT number", status: "Missing supplier tax details", href: `/bills/${b._id}`, severity: "low", confidence: "missing", exception: "Missing supplier tax details", module: "VAT" }));
  for (const i of proformas) for (const p of i.payments ?? []) {
    const t = new Date(p.paidOn).getTime();
    if (t < range.$gte.getTime() || t > range.$lte.getTime() || p.taxInvoice?.number) continue;
    rows.push(row(cur(i.currency, base), { id: `ti:${i._id}:${p._id}`, date: day(p.paidOn), section: "gaps", line: "tax_invoice", amountMinor: Number(p.amountMinor) || 0, title: i.customerName ?? "", number: i.invoiceNumber, category: "Pro-forma payment without its tax invoice", status: "Missing tax invoice", href: `/invoices/${i._id}`, severity: "medium", confidence: "missing", exception: "Missing tax invoice", module: "VAT" }));
  }
  for (const n of notes) rows.push(row(cur(n.currency, base), { id: `cnv:${n._id}`, date: day(n.issuedAt), section: "limits", line: "credit_notes", amountMinor: Number(n.taxTotalMinor) || 0, title: n.customerName ?? "", number: n.creditNoteNumber, category: "Credit note VAT not taken off output VAT", status: "Limitation", href: `/credit-notes/${n._id}` }));
  for (const r of rcExpenses.filter((x) => x.section === "vat" || (x.section === "classification" && x.line === "vat_control"))) rows.push({ ...r, id: `rcv:${r.id}`, section: "classification", line: r.section === "vat" ? "expense_vat" : "vat_control" });
  for (const r of docRows.filter((x) => x.section === "docs")) rows.push({ ...r, id: `doc:${r.id}`, section: "docs", line: r.line });
  const sides = sidesOf(rows, base, [
    { key: "vat", title: "VAT for the period — indicative, not a confirmed statutory liability", lines: [{ key: "output", label: "Output VAT" }, { key: "input", label: "Input VAT" }], showTotal: false },
    { key: "gaps", title: "Missing tax information", lines: [{ key: "tax_invoice", label: "Pro-forma payments without a tax invoice" }, { key: "vendor_vat", label: "Taxed bills from vendors with no VAT number" }] },
    { key: "classification", title: "VAT-related expense classification", lines: [{ key: "expense_vat", label: "VAT recorded on expenses (counted as cost, recoverability not recorded)" }, { key: "vat_control", label: "Expenses under VAT Control Account" }] },
    { key: "limits", title: "Known limits", lines: [{ key: "credit_notes", label: "VAT on credit notes issued (not taken off output VAT)" }] },
    { key: "docs", title: "Documentation gaps", lines: [{ key: "no_attachment", label: "Paid expenses with no supporting document" }, { key: "no_reference", label: "Paid expenses with no payment reference" }] },
  ], (_sum, currency) => currency === base ? [
    { key: "net", label: "Indicative net VAT (output − input) — not a confirmed liability; no VAT return is recorded in finance", amountMinor: vat.netPayableMinor, strong: true },
  ] : []);
  return { rows, sides };
}

// ── FC-08 Closing readiness ──────────────────────────────────────────────────

type Check = { key: string; label: string; status: "Complete" | "Incomplete" | "Requires review" | "Not applicable" | "Unable to verify"; amountMinor: number; detail: string };
const CHECKS = ["bank", "psp", "invoices", "expenses", "suppliers", "payroll", "commission", "advances", "receivables", "vat", "historical", "exceptions"];
const CHECK_LABEL: Record<string, string> = { bank: "Bank reconciliation", psp: "PSP settlement reconciliation", invoices: "Pending invoice approvals", expenses: "Pending expense approvals", suppliers: "Outstanding supplier obligations", payroll: "Payroll completion", commission: "Commission verification", advances: "Employee advance verification", receivables: "Receivable verification", vat: "VAT review", historical: "Historical balance verification", exceptions: "Unresolved critical and high exceptions" };

async function closingReport(orgId: string, base: string, from: string, to: string, today: string, ctx: { pending: RCRow[]; exceptions: RCRow[]; parts: Record<string, RCRow[]> }) {
  const [accounts, sessions, bills, runs] = await Promise.all([
    BankTransaction.aggregate([{ $match: { organizationId: oid(orgId) } }, { $group: { _id: "$accountId", first: { $min: "$date" } } }]),
    ReconciliationSession.find({ organizationId: oid(orgId), status: "completed" }).select("accountId statementDate").lean<any[]>(),
    Bill.find({ organizationId: oid(orgId), status: { $nin: ["draft", "voided"] } }).select("billDate dueDate totalMinor payments.paidOn payments.amountMinor amountPaidMinor").lean<any[]>(),
    PayrollRun.find({ organizationId: oid(orgId), status: { $nin: ["returned", "voided"] } }).select("period status").lean<any[]>(),
  ]);
  const rows: RCRow[] = [];
  const months: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= to && months.length < 24; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d.toISOString().slice(0, 7));
  for (const mo of months) {
    const end = new Date(payrollMonthEnd(mo)); end.setUTCHours(23, 59, 59, 999);
    const endT = end.getTime();
    const current = endT > Date.parse(`${today}T23:59:59Z`);
    const checks: Check[] = [];
    const active = accounts.filter((a) => new Date(a.first).getTime() <= endT);
    const done = active.filter((a) => sessions.some((s) => String(s.accountId) === String(a._id) && new Date(s.statementDate).getTime() >= endT - DAY));
    checks.push({ key: "bank", label: CHECK_LABEL.bank!, status: !active.length ? "Not applicable" : done.length === active.length ? "Complete" : "Incomplete", amountMinor: 0, detail: `${done.length} of ${active.length} accounts reconciled to this month's end` });
    const pspLate = (ctx.parts.psp ?? []).filter((r) => r.section === "pending" && r.severity && new Date(r.date).getTime() <= endT);
    const pspDiff = (ctx.parts.psp ?? []).filter((r) => r.section === "differences" && r.month === mo);
    checks.push({ key: "psp", label: CHECK_LABEL.psp!, status: pspLate.length || pspDiff.length ? "Requires review" : "Complete", amountMinor: [...pspLate, ...pspDiff].reduce((n, r) => n + Math.abs(r.amountMinor), 0), detail: `${pspLate.length} payment(s) pending beyond the cycle, ${pspDiff.length} settlement difference(s)` });
    for (const [key, types] of [["invoices", ["invoice", "balance_payment", "course_change"]], ["expenses", ["expense", "bill", "procurement", "reimbursement", "one_time_payment"]]] as const) {
      const open = ctx.pending.filter((r) => (types as readonly string[]).includes(r.line) && new Date(r.date).getTime() <= endT);
      checks.push({ key, label: CHECK_LABEL[key]!, status: open.length ? "Incomplete" : "Complete", amountMinor: open.reduce((n, r) => n + r.amountMinor, 0), detail: `${open.length} sent in or before this month still waiting` });
    }
    const overdueBills = bills.filter((b) => new Date(b.billDate).getTime() <= endT && b.dueDate && new Date(b.dueDate).getTime() < endT && (Number(b.totalMinor) || 0) - (b.payments ?? []).filter((p: any) => new Date(p.paidOn).getTime() <= endT).reduce((n: number, p: any) => n + (Number(p.amountMinor) || 0), 0) - Math.max(0, (Number(b.amountPaidMinor) || 0) - (b.payments ?? []).reduce((n: number, p: any) => n + (Number(p.amountMinor) || 0), 0)) > 0);
    checks.push({ key: "suppliers", label: CHECK_LABEL.suppliers!, status: overdueBills.length ? "Requires review" : "Complete", amountMinor: 0, detail: `${overdueBills.length} bill(s) overdue at month end` });
    const run = runs.find((r) => r.period === mo);
    checks.push({ key: "payroll", label: CHECK_LABEL.payroll!, status: !run ? (current ? "Not applicable" : "Unable to verify") : run.status === "paid" ? "Complete" : "Incomplete", amountMinor: 0, detail: run ? `run ${run.status}` : current ? "month not ended" : "no payroll run for this month in finance" });
    const overlap = (ctx.parts.payroll ?? []).filter((r) => r.section === "overlap" && r.severity && r.month === mo);
    checks.push({ key: "commission", label: CHECK_LABEL.commission!, status: overlap.length ? "Requires review" : "Complete", amountMinor: overlap.reduce((n, r) => n + r.amountMinor, 0), detail: `${overlap.length} typed commission expense(s) beside payouts` });
    checks.push({ key: "advances", label: CHECK_LABEL.advances!, status: "Unable to verify", amountMinor: 0, detail: "HRMS's recovery figures are not shared with finance" });
    const oldRec = (ctx.parts.historical ?? []).some((r) => r.section === "old_books" && r.line === "receivables");
    checks.push({ key: "receivables", label: CHECK_LABEL.receivables!, status: oldRec ? "Requires review" : "Complete", amountMinor: 0, detail: oldRec ? "old-books receivables are unverified" : "no unverified old-books receivables" });
    checks.push({ key: "vat", label: CHECK_LABEL.vat!, status: "Requires review", amountMinor: 0, detail: "finance keeps no record of a VAT return or review" });
    const opening = (ctx.parts.historical ?? []).filter((r) => r.section === "opening" && r.line === "unverified");
    checks.push({ key: "historical", label: CHECK_LABEL.historical!, status: opening.length ? "Unable to verify" : "Complete", amountMinor: 0, detail: opening.length ? `${opening.length} opening balance(s) not verified (cutover ${CUTOVER} proposed)` : "opening balances verified" });
    const exc = ctx.exceptions.filter((e) => (e.severity === "critical" || e.severity === "high") && e.month === mo);
    checks.push({ key: "exceptions", label: CHECK_LABEL.exceptions!, status: exc.length ? "Requires review" : "Complete", amountMinor: 0, detail: `${exc.length} critical/high exception(s) dated this month` });
    for (const c of checks) rows.push(row(base, { id: `close:${mo}:${c.key}`, date: day(end), section: mo, line: c.key, amountMinor: c.amountMinor, title: `${c.label}: ${c.status}`, category: c.label, status: c.status, detail: c.detail, href: "" }));
  }
  const sides = sidesOf(rows, base, months.map((mo) => ({ key: mo, title: `${mo} — readiness only, not closed (finance has no period lock)`, lines: CHECKS.map((k) => { const r = rows.find((x) => x.section === mo && x.line === k)!; return { key: k, label: `${CHECK_LABEL[k]}: ${r.status}` }; }), showTotal: false })), (_sum, currency) => {
    if (currency !== base) return [];
    const last = months[months.length - 1]!;
    const mine = rows.filter((r) => r.section === last);
    const n = (s: string) => mine.filter((r) => r.status === s).length;
    return [{ key: "ready", label: `${last}: ${n("Complete")} complete, ${n("Incomplete")} incomplete, ${n("Requires review")} to review, ${n("Unable to verify")} unable to verify, ${n("Not applicable")} not applicable — the period is not closed`, amountMinor: 0, strong: true, noAmount: true } as FPTotal & { noAmount: boolean }];
  });
  return { rows, sides, months };
}

// ── FC-09 Audit and activity ─────────────────────────────────────────────────

async function auditReport(orgId: string, base: string, from: string, to: string, today: string, warnings: string[]) {
  const rows: RCRow[] = [];
  const range = { $gte: new Date(`${from}T00:00:00Z`), $lte: new Date(`${to}T23:59:59.999Z`) };
  const [decided, rejected, late, runs, sessions, notes, voids, created] = await Promise.all([
    approvalsOf(orgId, base, today, warnings, "approved", { from, to }),
    approvalsOf(orgId, base, today, warnings, "rejected", { from, to }),
    LateEntry.find({ organizationId: oid(orgId), createdAt: range }).lean<any[]>(),
    PayrollRun.find({ organizationId: oid(orgId) }).select("runNumber deletedPayments payments.paymentId payments.amountMinor payments.currency payments.reversedAt payments.reversalReason payments.createdByName").lean<any[]>(),
    ReconciliationSession.find({ organizationId: oid(orgId), $or: [{ createdAt: range }, { completedAt: range }] }).select("accountName status statementDate createdAt completedAt completedByName differenceMinor currency").lean<any[]>(),
    CreditNote.find({ organizationId: oid(orgId), $or: [{ createdAt: range }, { issuedAt: range }] }).select("creditNoteNumber customerName status totalMinor currency createdAt issuedAt").lean<any[]>(),
    Invoice.find({ organizationId: oid(orgId), status: "void", updatedAt: range }).select("invoiceNumber customerName totalMinor currency updatedAt").lean<any[]>(),
    Promise.all([
      Invoice.countDocuments({ organizationId: oid(orgId), createdAt: range }), Invoice.countDocuments({ organizationId: oid(orgId), updatedAt: range, $expr: { $gt: [{ $subtract: ["$updatedAt", "$createdAt"] }, 60_000] } }),
      Expense.countDocuments({ organizationId: oid(orgId), createdAt: range }), Expense.countDocuments({ organizationId: oid(orgId), updatedAt: range, $expr: { $gt: [{ $subtract: ["$updatedAt", "$createdAt"] }, 60_000] } }),
      Bill.countDocuments({ organizationId: oid(orgId), createdAt: range }), Bill.countDocuments({ organizationId: oid(orgId), updatedAt: range, $expr: { $gt: [{ $subtract: ["$updatedAt", "$createdAt"] }, 60_000] } }),
      BankTransaction.countDocuments({ organizationId: oid(orgId), createdAt: range }), BankTransaction.countDocuments({ organizationId: oid(orgId), updatedAt: range, $expr: { $gt: [{ $subtract: ["$updatedAt", "$createdAt"] }, 60_000] } }),
    ]),
  ]);
  for (const r of [...decided, ...rejected]) rows.push(row(cur(r.currency, base), { id: `ap:${r.type}:${r.id}`, date: day(r.decidedAt ?? r.at), section: "approvals", line: r.status === "approved" ? "approved" : "rejected", amountMinor: r.amountMinor ?? 0, title: r.title, detail: [KIND_LABEL[r.type], r.reason ? `why: ${r.reason}` : ""].filter(Boolean).join(" · "), category: KIND_LABEL[r.type] ?? r.type, status: r.decidedBy ? `by ${r.decidedBy}` : "decided by: not recorded", account: r.decidedBy ?? "Not recorded", href: r.href }));
  for (const l of late) rows.push(row(cur(l.currency, base), { id: `le:${l._id}`, date: day(l.createdAt), section: "late", line: l.state, amountMinor: Number(l.amountMinor) || 0, title: `${l.kind.replace(/_/g, " ")} ${l.number ?? ""}`.trim(), detail: `entered by ${l.enteredByName || "—"}${l.decidedByName ? `, ${l.state} by ${l.decidedByName} on ${day(l.decidedAt)}` : ""} — ${l.reason}`, category: "Late entry", status: l.state, account: l.enteredByName || "Not recorded", href: "/late-entries" }));
  for (const r of runs) {
    for (const p of r.deletedPayments ?? []) if (p.deletedAt && new Date(p.deletedAt).getTime() >= range.$gte.getTime() && new Date(p.deletedAt).getTime() <= range.$lte.getTime()) rows.push(row(cur(p.currency, base), { id: `pd:${r._id}:${p.paymentId}`, date: day(p.deletedAt), section: "payroll", line: "deleted", amountMinor: Number(p.amountMinor) || 0, title: `${r.runNumber} payment ${p.paymentId}`, detail: `deleted by ${p.deletedByName || "—"}${p.reason ? ` — ${p.reason}` : ""}${p.expenseNumber ? ` (${p.expenseNumber})` : ""}`, category: "Payroll payment deleted", status: p.deletedByName ? `by ${p.deletedByName}` : "by: not recorded", account: p.deletedByName || "Not recorded", href: `/payroll/${r._id}` }));
    for (const p of r.payments ?? []) if (p.reversedAt && new Date(p.reversedAt).getTime() >= range.$gte.getTime() && new Date(p.reversedAt).getTime() <= range.$lte.getTime()) rows.push(row(cur(p.currency, base), { id: `pr:${r._id}:${p.paymentId}`, date: day(p.reversedAt), section: "payroll", line: "reversed", amountMinor: Number(p.amountMinor) || 0, title: `${r.runNumber} payment ${p.paymentId}`, detail: `reversed${p.reversalReason ? ` — ${p.reversalReason}` : ""}; who reversed it is not recorded (paid by ${p.createdByName || "—"})`, category: "Payroll payment reversed", status: "by: not recorded", account: "Not recorded", href: `/payroll/${r._id}` }));
  }
  for (const s of sessions) rows.push(row(cur(s.currency, base), { id: `rs:${s._id}`, date: day(s.completedAt ?? s.createdAt), section: "reconciliation", line: s.status === "completed" ? "completed" : "started", amountMinor: Number(s.differenceMinor) || 0, title: s.accountName ?? "", detail: `statement ${day(s.statementDate)}${s.completedByName ? `, completed by ${s.completedByName}` : ", not completed (who started it is not recorded)"}`, category: "Reconciliation", status: s.status, account: s.completedByName || "Not recorded", href: "/banking" }));
  for (const n of notes) rows.push(row(cur(n.currency, base), { id: `cn:${n._id}`, date: day(n.issuedAt ?? n.createdAt), section: "credit_notes", line: n.status === "draft" ? "draft" : "issued", amountMinor: Number(n.totalMinor) || 0, title: n.creditNoteNumber, detail: `${n.customerName ?? ""} — who made or issued it is not recorded`, category: "Credit note", status: n.status, account: "Not recorded", href: `/credit-notes/${n._id}` }));
  for (const v of voids) rows.push(row(cur(v.currency, base), { id: `iv:${v._id}`, date: day(v.updatedAt), section: "voids", line: "void", amountMinor: Number(v.totalMinor) || 0, title: v.invoiceNumber, detail: `${v.customerName ?? ""} — last changed ${day(v.updatedAt)}; who voided it and when is not recorded`, category: "Invoice voided", status: "void", account: "Not recorded", href: `/invoices/${v._id}` }));
  const [invC, invM, expC, expM, billC, billM, bankC, bankM] = created;
  const counts: [string, string, number][] = [["invoices", "Invoices", invC], ["invoices_m", "Invoices changed after creation", invM], ["expenses", "Expenses", expC], ["expenses_m", "Expenses changed after creation", expM], ["bills", "Bills", billC], ["bills_m", "Bills changed after creation", billM], ["bank", "Bank lines", bankC], ["bank_m", "Bank lines changed after creation", bankM]];
  for (const [k, label, n] of counts) rows.push(row(base, { id: `cnt:${k}`, date: to, section: k.endsWith("_m") ? "modified" : "created", line: k, amountMinor: 0, title: `${label}: ${n}`, category: label, detail: k.endsWith("_m") ? "what changed and who changed it are not recorded — only the time of the last change" : "created in the period", status: String(n), href: "" }));
  const sides = sidesOf(rows, base, [
    { key: "approvals", title: "Approval decisions in the period", lines: [{ key: "approved", label: "Approved" }, { key: "rejected", label: "Rejected or sent back" }] },
    { key: "late", title: "Late-entry activity", lines: [{ key: "pending", label: "Pending" }, { key: "approved", label: "Approved" }, { key: "rejected", label: "Rejected" }, { key: "withdrawn", label: "Withdrawn" }] },
    { key: "payroll", title: "Payroll payment changes", lines: [{ key: "deleted", label: "Payments deleted (who, when, why)" }, { key: "reversed", label: "Payments reversed (when, why — who not recorded)" }] },
    { key: "reconciliation", title: "Reconciliation activity", lines: [{ key: "completed", label: "Completed" }, { key: "started", label: "Started, not completed" }] },
    { key: "credit_notes", title: "Credit-note activity", lines: [{ key: "issued", label: "Issued or applied" }, { key: "draft", label: "Drafts" }] },
    { key: "voids", title: "Invoice voids (who and when not recorded)", lines: [{ key: "void", label: "Voided invoices last changed in the period" }] },
    { key: "created", title: "Records created in the period (counts in the line names)", lines: counts.filter(([k]) => !k.endsWith("_m")).map(([k, label, n]) => ({ key: k, label: `${label}: ${n}` })), showTotal: false },
    { key: "modified", title: "Records changed after creation (counts in the line names; what and who not recorded)", lines: counts.filter(([k]) => k.endsWith("_m")).map(([k, label, n]) => ({ key: k, label: `${label}: ${n}` })), showTotal: false },
  ], () => []);
  return { rows, sides };
}

// ── The reports ──────────────────────────────────────────────────────────────

const NOTES: Record<FCReport, string[]> = {
  overview: ["Live from finance. Every figure opens the report behind it; each is worked out by an earlier phase's report, not again here. No sample data."],
  approvals: [
    "From finance's Approvals service (every kind it gathers, read for the whole organization), plus late entries, draft credit notes and payroll runs not yet approved. Report Org shows them only — decisions are made in finance.",
    `Overdue = waiting more than ${OVERDUE_DAYS} days since it was sent. The approver shown is the permission that decides each kind; finance does not name a person. Department is shown where the record has one (expenses); otherwise "Not recorded". Commission is approved on finance's commission pages and is pending in the CRMs before that, so it is not in this list.`,
  ],
  risks: [
    "Phase 5's exceptions (RC-08), each once. Money at risk adds only confirmed discrepancies, each counted once; suspected items and missing information are listed with their recorded amounts but never added in or treated as losses.",
    `Long-outstanding = older than ${LONG_DAYS} days.`,
  ],
  liquidity: [
    "Phase 4's cash position and obligations. Balances are system-recorded; a reconciled (confirmed) balance is shown separately and is none until statements are reconciled.",
    "Potential surplus or shortfall = available recorded cash (bank + petty cash) less obligations due within 30 days and those with no recorded due date. Uncollected receivables and pending PSP money are not counted as available. Report Org never pays or approves anything.",
  ],
  expenses: [
    "Phase 5's expense findings, plus approvals, documents and timing. Unusual movement = a category's month against the average of the 3 months before, changed by at least 50% and at least 5,000 in its currency (bills and payroll left out).",
    "Late-recorded = had a late-entry approval, or was entered more than 30 days after its date. Category settings decide what counts in the P&L; nothing is changed here.",
  ],
  payroll: [
    "Payroll runs by stage and people on hold from finance's payroll; reversals, commission and typed-commission checks from Phase 5; advance discrepancies from Phase 4/5. The full-invoice-payment rule for commission eligibility is unchanged.",
    "A possible duplicate commission payment = a payout both paid by its own expense and carried by a payroll run (Phase 2A guards against it; this shows any that exist).",
  ],
  vat: [
    "VAT figures are finance's VAT report for the period — indicative only, not a confirmed statutory liability. No VAT return, payment schedule or filing is recorded in finance; no tax rule is added here.",
    "Credit notes do not reduce output VAT in finance's VAT report: their VAT is listed as a known limit. Expense VAT is counted as cost; whether it is recoverable is not recorded.",
  ],
  closing: [
    "Readiness only. Each check is worked out from records; a complete checklist does not close a period. Finance has no period lock, so no month is closed, reopened or locked here.",
    "Future proposal (separate approval): a \"books closed up to\" date per organization, refused edits dated on or before it, and a reopen with a reason — this needs a schema change.",
  ],
  audit: [
    "Finance keeps no audit log: only activity records already carry is shown — approval decisions, late entries, payroll payment deletions and reversals, reconciliation completion, credit notes, and record creation and last-change times. Who voided an invoice, and edits or deletions of payments, are not recorded and are not made up.",
    "A full audit trail (who changed what, before and after) would need a new audit log — a separate proposal.",
  ],
};

export async function controlsReport(orgId: string, report: FCReport, from: string, to: string) {
  const base = (await baseCurrencyOf(orgId)).toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const asOf = to > today ? today : to;
  const warnings: string[] = [];
  const done = (rows: RCRow[], sides: FPSide[], indicators: FCIndicator[] = []) => ({ report, currency: base, from, to, asOf, sides, months: [], notes: NOTES[report], warnings, recordCount: rows.length, rows, indicators });

  if (report === "audit") { const a = await auditReport(orgId, base, from, to, today, warnings); return done(a.rows, a.sides); }
  if (report === "approvals") { const a = await approvalsReport(orgId, base, today, warnings); return done(a.rows, a.sides); }
  if (report === "liquidity") {
    const [cash, obl] = await Promise.all([financialReport(orgId, "cash", from, to), financialReport(orgId, "obligations", from, to)]);
    warnings.push(...cash.warnings, ...obl.warnings);
    const l = liquidityReport(cash, obl, base, asOf);
    return done(l.rows, l.sides);
  }
  const rc = await reconciliationReport(orgId, "summary", from, to, { withParts: true }) as Awaited<ReturnType<typeof reconciliationReport>> & { parts: Record<string, RCRow[]> };
  warnings.push(...rc.warnings);
  const parts = rc.parts;
  if (report === "risks") { const r = risksReport(rc.rows as RCRow[], base); return done(r.rows, r.sides); }
  const appr = await approvalsReport(orgId, base, today, warnings);
  if (report === "expenses") { const e = await expensesReport(orgId, base, from, to, today, parts.expenses ?? [], appr.pending); return done(e.rows, e.sides); }
  if (report === "payroll") { const obl = await financialReport(orgId, "obligations", from, to); warnings.push(...obl.warnings); const p = await payrollReport(orgId, base, today, parts.payroll ?? [], parts.advances ?? [], obl.rows as RCRow[]); return done(p.rows, p.sides); }
  if (report === "vat") { const e = await expensesReport(orgId, base, from, to, today, parts.expenses ?? [], []); const v = await vatReport(orgId, base, from, to, parts.expenses ?? [], e.rows); return done(v.rows, v.sides); }
  if (report === "closing") { const c = await closingReport(orgId, base, from, to, today, { pending: appr.pending, exceptions: rc.rows as RCRow[], parts }); return done(c.rows, c.sides); }

  // Overview: the dashboard, each figure from the report it opens.
  const [cash, obl, exp, pay, close] = await Promise.all([
    financialReport(orgId, "cash", from, to), financialReport(orgId, "obligations", from, to),
    expensesReport(orgId, base, from, to, today, parts.expenses ?? [], appr.pending),
    financialReport(orgId, "obligations", from, to).then((o) => payrollReport(orgId, base, today, parts.payroll ?? [], parts.advances ?? [], o.rows as RCRow[])),
    closingReport(orgId, base, from, to, today, { pending: appr.pending, exceptions: rc.rows as RCRow[], parts }),
  ]);
  const currencies = [...new Set([base, ...appr.pending.map((r) => r.currency), ...(rc.rows as RCRow[]).map((r) => r.currency), ...obl.sides.map((s) => s.currency)])];
  const indicators: FCIndicator[] = [];
  const lastMonth = close.months[close.months.length - 1];
  for (const c of currencies) {
    const pend = appr.pending.filter((r) => r.currency === c);
    const exc = (rc.rows as RCRow[]).filter((r) => r.currency === c);
    const oblSide = obl.sides.find((s) => s.currency === c);
    const oblLine = (k: string) => oblSide?.sections.flatMap((x) => x.lines).find((l) => l.key === `obl:${k}`)?.amountMinor ?? 0;
    const unrec = rc.indicators.find((i) => i.currency === c && i.key === "unreconciled")?.value ?? 0;
    const pspLate = (parts.psp ?? []).filter((r) => r.currency === c && r.section === "pending" && r.severity).length;
    const gaps = exp.rows.filter((r) => r.currency === c && r.section === "docs").length;
    const add = (key: string, label: string, value: number | null, as: FCIndicator["as"], rep: string, line = "all", note?: string) => indicators.push({ currency: c, key, label, value, as, report: rep, line, ...(note ? { note } : {}) });
    add("pending", "Pending financial approvals", pend.length, "count", "approvals", "pending");
    add("pending_amount", "Amount awaiting approval", pend.reduce((n, r) => n + r.amountMinor, 0), "money", "approvals", "pending");
    add("overdue", `Approvals overdue (more than ${OVERDUE_DAYS} days)`, pend.filter((r) => (r.ageDays ?? 0) > OVERDUE_DAYS).length, "count", "approvals", "age");
    add("critical", "Critical financial exceptions", exc.filter((r) => r.severity === "critical").length, "count", "risks", "sev_critical");
    add("high", "High-priority financial exceptions", exc.filter((r) => r.severity === "high").length, "count", "risks", "sev_high");
    add("unreconciled", "Unreconciled bank accounts", unrec, "count", "liquidity", "cash");
    add("psp_overdue", "PSP payments overdue for settlement", pspLate, "count", "liquidity", "psp");
    add("obligations", "Outstanding payment obligations", oblSide ? oblSide.totals.find((t) => t.key === "total")?.amountMinor ?? 0 : 0, "money", "liquidity", "due_soon");
    add("salaries_commission", "Unpaid salaries and commission", pay.rows.filter((r) => r.currency === c && r.section === "owed").reduce((n, r) => n + r.amountMinor, 0), "money", "payroll", "owed");
    add("doc_gaps", "Financial documentation gaps", gaps, "count", "expenses", "docs");
    if (c === base && lastMonth) {
      const mine = close.rows.filter((r) => r.section === lastMonth);
      add("closing", `Closing readiness ${lastMonth}: checks complete of ${mine.length}`, mine.filter((r) => r.status === "Complete").length, "count", "closing", lastMonth, "Readiness only — no period is closed");
    }
  }
  warnings.push(...cash.warnings.filter((w) => !warnings.includes(w)));
  return done([], [], indicators);
}

/** The records behind one figure: "<section>:<line>", a section, or "all". */
export function fcLinesOf(rows: RCRow[], line: string): RCRow[] {
  if (!line || line === "all") return rows;
  const i = line.indexOf(":");
  const section = i < 0 ? line : line.slice(0, i), key = i < 0 ? undefined : line.slice(i + 1);
  return rows.filter((r) => r.section === section && (key === undefined || r.line === key));
}
