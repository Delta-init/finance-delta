import { Types } from "mongoose";
import { Invoice } from "../invoice/invoice.model";
import { CreditNote } from "../credit-note/credit-note.model";
import { Bill } from "../bill/bill.model";
import { Expense } from "../expense/expense.model";
import { PayrollRun } from "../payroll/payroll-run.model";
import { payrollMonthEnd } from "../payroll/payroll-month";
import { CommissionRecord } from "../commission/commission-record.model";
import { CrmCommissionPayout } from "../crm-commission/crm-commission-payout.model";
import { CsCommissionPayout } from "../cs-commission/cs-commission-payout.model";
import { BankAccount } from "../banking/bank-account.model";
import { BankTransaction } from "../banking/bank-transaction.model";
import { Loan } from "../loan/loan.model";
import { LoanRepayment } from "../loan/loan-repayment.model";
import { baseCurrencyOf, crmOf, getVATReport } from "./reports.service";
import { listHistory as advanceHistory } from "../advances/advances.service";
import { listWaiting as reimbursementsWaiting } from "../reimbursements/reimbursements.service";

/*
 * Cash flow and financial position (Phase 4, 2026-11-27) — management reports beside the P&L and Phase 3, built from
 * the records finance already keeps (bank lines, invoices, credit notes, bills, payroll runs, commission, expenses,
 * loans, advances), read-only:
 *
 *   cashflow     the period's bank lines by activity (operating, investing, financing), with opening and closing
 *                balances; transfers between own accounts out of money in/out but in each account's balance.
 *   cash         every account's balance as of a date: bank, petty cash, PSP money waiting to settle.
 *   receivables  what customers owe as of a date: payments and credits after the date not taken off.
 *   obligations  what the organization owes as of a date: bills, salaries, commission, expenses, reimbursements, loans.
 *   advances     salary advances given and recovered from pay.
 *   position     the above together — a Management Financial Position, not a statutory balance sheet.
 *
 * Approved 2026-11-27 (as recommended): Office Setup counts as investing (repairs stay operating), interest as
 * operating, staff advances as operating; available cash = bank + petty cash as recorded, negative accounts flagged but
 * counted; upcoming obligations = every approved unpaid obligation; old-books receivables apart and out of the net;
 * pro-forma balances apart as conditional, the net given with and without them; reimbursements read live from HRMS.
 * Each currency apart, never converted.
 */

export type FPReport = "cashflow" | "cash" | "receivables" | "obligations" | "advances" | "position";
export const FP_REPORTS: FPReport[] = ["cashflow", "cash", "receivables", "obligations", "advances", "position"];

/** One record behind a figure; `section`/`line` say where it is counted. */
export type FPRow = {
  id: string; date: string; month: string; number: string; title: string; detail: string;
  section: string; line: string; category: string; status: string; amountMinor: number; currency: string; href: string;
  account?: string; crm?: string; band?: string; kind?: string; due?: string; overdueDays?: number;
  originalMinor?: number; settledMinor?: number; creditMinor?: number;
};
export type FPLine = { key: string; label: string; amountMinor: number; count: number };
export type FPSection = { key: string; title: string; lines: FPLine[]; totalMinor: number; showTotal: boolean };
export type FPTotal = { key: string; label: string; amountMinor: number; strong?: boolean };
export type FPSide = { currency: string; sections: FPSection[]; totals: FPTotal[] };

const oid = (id: string) => new Types.ObjectId(id);
const day = (d: unknown) => (d ? new Date(d as Date).toISOString().slice(0, 10) : "");
const endOf = (d: string) => new Date(`${d}T23:59:59.999Z`);
const startOf = (d: string) => new Date(`${d}T00:00:00.000Z`);
const DAY = 86_400_000;
const LIVE_RUN = ["approved", "partially_paid", "paid"];
const COMMISSION_SOURCES = new Set(["commission", "crm_commission", "cs_commission", "crm_slab"]);
const CRM_SOURCES = new Set(["crm", "draw-crm", "banglore-crm"]);

export const BANDS = [
  { key: "not_due", label: "Not yet due" },
  { key: "d1_30", label: "1–30 days overdue" },
  { key: "d31_60", label: "31–60 days overdue" },
  { key: "d61_90", label: "61–90 days overdue" },
  { key: "d91_180", label: "91–180 days overdue" },
  { key: "d181_365", label: "181–365 days overdue" },
  { key: "d365_plus", label: "More than 365 days overdue" },
  { key: "no_due", label: "No valid due date" },
] as const;
function bandOf(due: Date | null | undefined, asOf: Date): { band: string; overdue: number } {
  if (!due || Number.isNaN(+new Date(due))) return { band: "no_due", overdue: 0 };
  const late = Math.floor((asOf.getTime() - new Date(due).getTime()) / DAY);
  const band = late <= 0 ? "not_due" : late <= 30 ? "d1_30" : late <= 60 ? "d31_60" : late <= 90 ? "d61_90" : late <= 180 ? "d91_180" : late <= 365 ? "d181_365" : "d365_plus";
  return { band, overdue: Math.max(0, late) };
}

/** Sums rows into sections, per currency, in the order `layout` gives (lines with nothing are left out). */
function sidesOf(rows: FPRow[], base: string, layout: { key: string; title: string; lines: { key: string; label: string }[]; showTotal?: boolean }[], totals: (sum: (section: string, line?: string) => number, currency: string) => FPTotal[]): FPSide[] {
  const currencies = [...new Set([base, ...rows.map((r) => r.currency)])];
  return currencies.map((currency) => {
    const mine = rows.filter((r) => r.currency === currency);
    const sum = (section: string, line?: string) => mine.filter((r) => r.section === section && (line === undefined || r.line === line)).reduce((n, r) => n + r.amountMinor, 0);
    const sections = layout.map((s) => {
      const lines = s.lines.map((l) => ({ key: `${s.key}:${l.key}`, label: l.label, amountMinor: sum(s.key, l.key), count: mine.filter((r) => r.section === s.key && r.line === l.key).length })).filter((l) => l.count > 0);
      return { key: s.key, title: s.title, lines, totalMinor: sum(s.key), showTotal: s.showTotal !== false };
    }).filter((s) => s.lines.length > 0);
    return { currency, sections, totals: totals(sum, currency) };
  }).filter((s) => s.currency === base || s.sections.length > 0);
}

/** The month ends of from..to ("2026-10-31"), at most 24 — as-of reports are given at each. */
function monthEnds(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= to && out.length < 24; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    out.push(end > to ? to : end);
  }
  return out;
}
const monthsOf = (from: string, to: string) => monthEnds(from, to).map((end) => ({ month: end.slice(0, 7), from: end.slice(0, 7) + "-01" < from ? from : end.slice(0, 7) + "-01", to: end }));

// ── Bank data (cash flow and cash position) ──────────────────────────────────

type Acc = { _id: Types.ObjectId; accountName: string; accountType: string; currency: string; openingBalanceMinor?: number; openingDate: Date; currentBalanceMinor?: number; isActive?: boolean; lastReconciledAt?: Date; lastReconciledStatementBalanceMinor?: number };
type Line = { _id: Types.ObjectId; accountId: Types.ObjectId; date: Date; createdAt?: Date; amountMinor: number; description?: string; reference?: string; status?: string; matches?: { type: string; referenceId: string; referenceNumber: string }[]; transfer?: { id: unknown; otherAccountName?: string } | null; settlement?: { number?: string } | null; category?: string | null; subcategory?: string | null; isReconciled?: boolean };

async function bankData(orgId: string) {
  const [accounts, lines] = await Promise.all([
    BankAccount.find({ organizationId: oid(orgId) }).lean<Acc[]>(),
    BankTransaction.find({ organizationId: oid(orgId) }).select("accountId date createdAt amountMinor description reference status matches transfer settlement category subcategory isReconciled").lean<Line[]>(),
  ]);
  const expenseIds = lines.flatMap((l) => (l.matches ?? []).filter((m) => m.type === "expense").map((m) => m.referenceId)).filter((x) => Types.ObjectId.isValid(x));
  const cats = new Map((await Expense.find({ _id: { $in: expenseIds } }).select("category subcategory").lean<any[]>()).map((e) => [String(e._id), { category: e.category as string, subcategory: e.subcategory as string | null }]));
  return { accounts, lines, cats, accById: new Map(accounts.map((a) => [String(a._id), a])) };
}
type BankData = Awaited<ReturnType<typeof bankData>>;

/** Where a bank line belongs in the cash flow (approved mapping, 2026-11-27). */
function classify(l: Line, cats: BankData["cats"]): { section: string; line: string } {
  if (l.transfer && (l.transfer as { id?: unknown }).id) return { section: "transfers", line: l.amountMinor > 0 ? "in" : "out" };
  if (l.status === "duplicate") return { section: "flagged", line: "duplicate" };
  const inflow = l.amountMinor > 0;
  const m = (l.matches ?? [])[0];
  const fromExpense = m?.type === "expense" ? cats.get(String(m.referenceId)) : undefined;
  const cat = fromExpense?.category ?? (m ? undefined : l.category ?? undefined);
  const sub = fromExpense?.subcategory ?? (m ? undefined : l.subcategory ?? undefined);
  if (m?.type === "invoice") return { section: "operating", line: inflow ? "collections" : "customer_refunds" };
  if (m?.type === "bill") return { section: "operating", line: "suppliers" };
  if (m?.type === "payroll") return { section: "operating", line: "salaries" };
  if (!cat) return { section: "unidentified", line: inflow ? "in" : "out" };
  if (cat === "sales_commission") return { section: "operating", line: "commission" };
  if (cat === "payroll_benefits" || cat === "payroll_payable") return { section: "operating", line: "salaries" };
  if (cat === "rent_utilities") return { section: "operating", line: "rent" };
  if (cat === "vat_control") return { section: "operating", line: "tax" };
  if (cat === "employee_advances") return { section: "operating", line: "advances" };
  if (cat === "office_setup" && sub !== "repairs_maintenance") return { section: "investing", line: inflow ? "asset_disposals" : "asset_purchases" };
  if (cat === "other_unclassified" && sub === "intercompany_investments") return { section: "investing", line: inflow ? "investment_recoveries" : "investments" };
  if (cat === "loan_financing" && sub === "loan_principal") return { section: "financing", line: inflow ? "loan_receipts" : "loan_repayments" };
  if (cat === "other_unclassified" && sub === "partner_distributions") return { section: "financing", line: inflow ? "capital" : "distributions" };
  if (cat === "loan_financing") return { section: "operating", line: "interest" };
  return { section: "operating", line: inflow ? "other_receipts" : "operating_expenses" };
}

const CASHFLOW_LAYOUT = [
  { key: "operating", title: "Operating activities", lines: [
    { key: "collections", label: "Customer collections" }, { key: "customer_refunds", label: "Money back to customers" },
    { key: "suppliers", label: "Supplier payments" }, { key: "salaries", label: "Salary payments" }, { key: "commission", label: "Commission payments" },
    { key: "rent", label: "Rent and utilities" }, { key: "operating_expenses", label: "Other operating expenses" }, { key: "tax", label: "Tax payments (VAT)" },
    { key: "interest", label: "Interest and financing fees" }, { key: "advances", label: "Employee advances" }, { key: "other_receipts", label: "Other operating receipts" },
  ] },
  { key: "investing", title: "Investing activities", lines: [
    { key: "asset_purchases", label: "Asset purchases (office setup, equipment)" }, { key: "asset_disposals", label: "Asset disposals" },
    { key: "investments", label: "Investments" }, { key: "investment_recoveries", label: "Investment recoveries" },
  ] },
  { key: "financing", title: "Financing activities", lines: [
    { key: "capital", label: "Capital contributions" }, { key: "distributions", label: "Partner withdrawals and distributions" },
    { key: "loan_receipts", label: "Loan receipts" }, { key: "loan_repayments", label: "Loan repayments" },
  ] },
  { key: "unidentified", title: "Not identified (matched to no record)", lines: [{ key: "in", label: "Money in, not identified" }, { key: "out", label: "Money out, not identified" }] },
  { key: "flagged", title: "Marked duplicate (still in the balances)", lines: [{ key: "duplicate", label: "Lines marked duplicate" }] },
  { key: "transfers", title: "Transfers between own accounts (out of money in/out)", lines: [{ key: "in", label: "Transfers in" }, { key: "out", label: "Transfers out" }] },
];

function lineRow(l: Line, acc: Acc | undefined, where: { section: string; line: string }): FPRow {
  const m = (l.matches ?? [])[0];
  const date = day(l.date);
  return {
    id: String(l._id), date, month: date.slice(0, 7), number: m?.referenceNumber || l.reference || l.settlement?.number || "", title: l.description || "",
    detail: [l.transfer ? `transfer, other side ${(l.transfer as { otherAccountName?: string }).otherAccountName ?? ""}` : "", l.status === "duplicate" ? "marked duplicate" : "", m ? `matched to ${m.type}` : "matched to no record"].filter(Boolean).join(" · "),
    section: where.section, line: where.line, category: where.line, status: l.status ?? "", amountMinor: l.amountMinor, currency: String(acc?.currency ?? "").toUpperCase(), href: acc ? `/banking/${acc._id}` : "/banking", account: acc?.accountName ?? "",
  };
}

/** Balance of each account as at the end of `d` (opening counts from its opening date). */
function balancesAt(data: BankData, d: string | null): Map<string, number> {
  const out = new Map<string, number>();
  const cut = d ? endOf(d).getTime() : Infinity;
  for (const a of data.accounts) out.set(String(a._id), new Date(a.openingDate).getTime() <= cut ? Number(a.openingBalanceMinor) || 0 : 0);
  for (const l of data.lines) if (new Date(l.date).getTime() <= cut) out.set(String(l.accountId), (out.get(String(l.accountId)) ?? 0) + (Number(l.amountMinor) || 0));
  return out;
}

function cashflowOf(data: BankData, base: string, from: string, to: string) {
  const lo = startOf(from).getTime(), hi = endOf(to).getTime();
  const rows: FPRow[] = [];
  for (const l of data.lines) {
    const t = new Date(l.date).getTime();
    if (t < lo || t > hi || !l.amountMinor) continue;
    rows.push(lineRow(l, data.accById.get(String(l.accountId)), classify(l, data.cats)));
  }
  const before = new Date(lo - 1).toISOString().slice(0, 10);
  const open = balancesAt(data, before), close = balancesAt(data, to);
  // Accounts opened inside the period: their opening balance arrives on the opening day — said, never hidden.
  const openedIn = data.accounts.filter((a) => { const t = new Date(a.openingDate).getTime(); return t >= lo && t <= hi && (Number(a.openingBalanceMinor) || 0) !== 0; });
  const per = (currency: string, m: Map<string, number>) => data.accounts.filter((a) => String(a.currency).toUpperCase() === currency).reduce((n, a) => n + (m.get(String(a._id)) ?? 0), 0);
  const sides = sidesOf(rows, base, CASHFLOW_LAYOUT, (sum, currency) => {
    const opening = per(currency, open), closing = per(currency, close);
    const openedMinor = openedIn.filter((a) => String(a.currency).toUpperCase() === currency).reduce((n, a) => n + (Number(a.openingBalanceMinor) || 0), 0);
    const mine = rows.filter((r) => r.currency === currency && r.section !== "transfers");
    const inflows = mine.filter((r) => r.amountMinor > 0).reduce((n, r) => n + r.amountMinor, 0);
    const outflows = -mine.filter((r) => r.amountMinor < 0).reduce((n, r) => n + r.amountMinor, 0);
    const transfers = sum("transfers");
    const expected = opening + openedMinor + inflows - outflows + transfers;
    return [
      { key: "opening", label: "Opening cash and bank balance", amountMinor: opening, strong: true },
      ...(openedMinor ? [{ key: "opened", label: "Opening balances of accounts opened in the period", amountMinor: openedMinor }] : []),
      { key: "operating", label: "Net cash from operating activities", amountMinor: sum("operating") },
      { key: "investing", label: "Net cash from investing activities", amountMinor: sum("investing") },
      { key: "financing", label: "Net cash from financing activities", amountMinor: sum("financing") },
      { key: "unidentified", label: "Net not identified", amountMinor: sum("unidentified") },
      { key: "flagged", label: "Net of lines marked duplicate", amountMinor: sum("flagged") },
      { key: "inflows", label: "Total cash inflows (transfers out)", amountMinor: inflows },
      { key: "outflows", label: "Total cash outflows (transfers out)", amountMinor: outflows },
      { key: "net", label: "Net cash movement", amountMinor: inflows - outflows, strong: true },
      { key: "transfers", label: "Transfers between own accounts, net", amountMinor: transfers },
      { key: "closing", label: "Closing cash and bank balance", amountMinor: closing, strong: true },
      { key: "check", label: "Check: opening + movement + transfers − closing (0 = reconciles)", amountMinor: expected - closing },
    ];
  });
  return { rows, sides };
}

/** Each account as of `asOf`: balance, last line, reconciliation — and what is stored on it now, for comparison. */
function accountsAt(data: BankData, asOf: string) {
  const bal = balancesAt(data, asOf), all = balancesAt(data, null);
  const cut = endOf(asOf).getTime();
  return data.accounts.map((a) => {
    const mine = data.lines.filter((l) => String(l.accountId) === String(a._id));
    const upTo = mine.filter((l) => new Date(l.date).getTime() <= cut);
    const last = upTo.reduce((t, l) => Math.max(t, new Date(l.date).getTime()), 0);
    const later = mine.filter((l) => new Date(l.date).getTime() > cut).length;
    const reconciled = upTo.filter((l) => l.isReconciled).length;
    return {
      id: String(a._id), name: a.accountName, type: a.accountType, currency: String(a.currency).toUpperCase(), active: a.isActive !== false,
      opening: new Date(a.openingDate).getTime() <= cut ? Number(a.openingBalanceMinor) || 0 : 0, openingDate: day(a.openingDate),
      balanceMinor: bal.get(String(a._id)) ?? 0, storedMinor: Number(a.currentBalanceMinor) || 0, allLinesMinor: all.get(String(a._id)) ?? 0,
      lastLine: last ? day(new Date(last)) : "", lines: upTo.length, linesAfter: later, reconciledLines: reconciled,
      lastReconciledAt: day(a.lastReconciledAt), confirmedMinor: a.lastReconciledStatementBalanceMinor ?? null,
    };
  });
}
type AccountAt = ReturnType<typeof accountsAt>[number];

function cashOf(data: BankData, base: string, asOf: string) {
  const accounts = accountsAt(data, asOf).filter((a) => a.openingDate <= asOf || a.lines > 0);
  const group = (a: AccountAt) => (a.type === "psp" ? "psp" : a.type === "petty_cash" ? "petty" : "bank");
  const rows: FPRow[] = accounts.map((a) => ({
    id: a.id, date: a.lastLine || a.openingDate, month: (a.lastLine || a.openingDate).slice(0, 7), number: a.type, title: a.name,
    detail: [`opening ${(a.opening / 100).toFixed(2)} on ${a.openingDate}`, `${a.lines} lines, ${a.reconciledLines} reconciled`, a.lastReconciledAt ? `last reconciled ${a.lastReconciledAt}` : "never reconciled", a.balanceMinor < 0 ? "NEGATIVE — records incomplete" : "", a.linesAfter ? `${a.linesAfter} line(s) dated after ${asOf}` : ""].filter(Boolean).join(" · "),
    section: group(a), line: a.id, category: a.type, status: a.reconciledLines ? "Partly reconciled" : "Not reconciled", amountMinor: a.balanceMinor, currency: a.currency, href: `/banking/${a.id}`, account: a.name,
  }));
  const layout = (["bank", "petty", "psp"] as const).map((g) => ({
    key: g, title: g === "bank" ? "Bank accounts (system-recorded)" : g === "petty" ? "Petty cash wallets (system-recorded)" : "Payment gateway (PSP) balances — pending settlement",
    lines: accounts.filter((a) => group(a) === g).map((a) => ({ key: a.id, label: `${a.name}${a.balanceMinor < 0 ? " ⚠ negative" : ""}` })),
  }));
  const sides = sidesOf(rows, base, layout, (sum, currency) => {
    const mine = accounts.filter((a) => a.currency === currency);
    const confirmed = mine.filter((a) => a.confirmedMinor !== null);
    return [
      { key: "available", label: "Estimated available cash (bank + petty cash as recorded)", amountMinor: sum("bank") + sum("petty"), strong: true },
      { key: "psp", label: "Pending PSP settlements (not in available cash)", amountMinor: sum("psp") },
      { key: "recorded", label: "All system-recorded balances", amountMinor: sum("bank") + sum("petty") + sum("psp") },
      { key: "confirmed", label: confirmed.length ? `Confirmed by a reconciled statement (${confirmed.length} account(s))` : "Confirmed by a reconciled statement: none reconciled", amountMinor: confirmed.reduce((n, a) => n + (a.confirmedMinor ?? 0), 0) },
      { key: "negative", label: "Of which accounts below zero (records incomplete)", amountMinor: mine.filter((a) => a.balanceMinor < 0).reduce((n, a) => n + a.balanceMinor, 0) },
      { key: "restricted", label: "Restricted or unavailable funds: none recorded in finance", amountMinor: 0 },
    ];
  });
  return { rows, sides, accounts };
}

// ── Receivables ──────────────────────────────────────────────────────────────

type InvDoc = { _id: Types.ObjectId; invoiceNumber: string; customerName?: string; salespersonName?: string; issueDate: Date; dueDate?: Date; status: string; currency?: string; totalMinor?: number; proforma?: { at?: Date }; external?: { source?: string }; enrolment?: { crm?: string }; payments?: { paidOn: Date; amountMinor: number }[] };
async function receivableData(orgId: string, upTo: string) {
  const [invoices, notes] = await Promise.all([
    Invoice.find({ organizationId: oid(orgId), status: { $nin: ["draft", "void"] }, issueDate: { $lte: endOf(upTo) } })
      .select("invoiceNumber customerName salespersonName issueDate dueDate status currency totalMinor proforma external.source enrolment.crm payments.paidOn payments.amountMinor").lean<InvDoc[]>(),
    CreditNote.find({ organizationId: oid(orgId), status: { $in: ["issued", "applied"] }, amountAppliedMinor: { $gt: 0 } }).select("invoiceId amountAppliedMinor applications issuedAt").lean<any[]>(),
  ]);
  // Credit applied to each invoice and when: each recorded application on its day; an older note without a record of
  // where it went, on its own invoice on the day it was issued (production has none — Phase 2A).
  const credits = new Map<string, { at: number; amount: number }[]>();
  const add = (inv: unknown, at: unknown, amount: number) => { const k = String(inv); const l = credits.get(k) ?? []; l.push({ at: new Date(at as Date).getTime(), amount }); credits.set(k, l); };
  for (const n of notes) {
    if (Array.isArray(n.applications) && n.applications.length) for (const a of n.applications) add(a.invoiceId, a.appliedAt ?? n.issuedAt, Number(a.amountMinor) || 0);
    else add(n.invoiceId, n.issuedAt, Number(n.amountAppliedMinor) || 0);
  }
  return { invoices, credits };
}
type RecData = Awaited<ReturnType<typeof receivableData>>;

const KIND_LABEL: Record<string, string> = { invoice: "Invoices issued (balance due)", enrolment: "Enrolment balances — rolling 29-day instalment", proforma: "Pro-forma balances — conditional future instalments, not yet tax-invoiced", old_books: "Imported from old books (kept apart, out of the net position)" };
function kindOf(inv: InvDoc): string {
  if (inv.proforma?.at) return "proforma";
  const src = inv.external?.source ?? "";
  if (src === "old_books" || src === "old-books") return "old_books";
  if (CRM_SOURCES.has(src)) return "enrolment";
  return "invoice";
}

function receivablesOf(data: RecData, base: string, asOf: string) {
  const cut = endOf(asOf).getTime();
  const at = endOf(asOf);
  const rows: FPRow[] = [];
  for (const inv of data.invoices) {
    if (new Date(inv.issueDate).getTime() > cut) continue;
    const total = Number(inv.totalMinor) || 0;
    const paid = (inv.payments ?? []).filter((p) => new Date(p.paidOn).getTime() <= cut).reduce((n, p) => n + (Number(p.amountMinor) || 0), 0);
    const credit = (data.credits.get(String(inv._id)) ?? []).filter((c) => c.at <= cut).reduce((n, c) => n + c.amount, 0);
    const owed = total - paid - credit;
    if (owed <= 0) continue;
    const kind = kindOf(inv);
    const { band, overdue } = bandOf(inv.dueDate, at);
    const date = day(inv.issueDate);
    rows.push({
      id: String(inv._id), date, month: date.slice(0, 7), number: inv.invoiceNumber, title: inv.customerName ?? "", detail: inv.salespersonName ?? "",
      section: "kind", line: kind, category: KIND_LABEL[kind]!.split(" (")[0]!.split(" —")[0]!, status: BANDS.find((b) => b.key === band)!.label, amountMinor: owed, currency: String(inv.currency || base).toUpperCase(),
      href: `/invoices/${inv._id}`, crm: crmOf(inv), band, kind, due: day(inv.dueDate), overdueDays: overdue, originalMinor: total, settledMinor: paid, creditMinor: credit,
    });
  }
  // The same records again under their age band, for the ageing section (the totals use the kind section only).
  const banded = rows.map((r) => ({ ...r, section: "age", line: r.band! }));
  const all = [...rows, ...banded];
  const sides = sidesOf(all, base, [
    { key: "kind", title: "Outstanding by kind", lines: Object.entries(KIND_LABEL).map(([key, label]) => ({ key, label })) },
    { key: "age", title: "Ageing (by due date)", lines: BANDS.map((b) => ({ key: b.key, label: b.label })) },
  ], (sum, currency) => {
    const mine = rows.filter((r) => r.currency === currency);
    const s = (k: keyof FPRow) => mine.reduce((n, r) => n + (Number(r[k]) || 0), 0);
    const overdue = mine.filter((r) => (r.overdueDays ?? 0) > 0).reduce((n, r) => n + r.amountMinor, 0);
    const notDue = mine.filter((r) => r.band === "not_due").reduce((n, r) => n + r.amountMinor, 0);
    return [
      { key: "invoiced", label: "Total invoiced (on invoices still open)", amountMinor: s("originalMinor") },
      { key: "received", label: "Payments received on them (to the date)", amountMinor: s("settledMinor") },
      { key: "credited", label: "Credit notes applied (to the date)", amountMinor: s("creditMinor") },
      { key: "outstanding", label: "Outstanding, all kinds", amountMinor: s("amountMinor"), strong: true },
      { key: "enforceable", label: "Due on issued invoices and enrolment balances (not guaranteed collectible)", amountMinor: sum("kind", "invoice") + sum("kind", "enrolment"), strong: true },
      { key: "conditional", label: "Conditional (pro-forma balances)", amountMinor: sum("kind", "proforma") },
      { key: "old_books", label: "Old books (apart)", amountMinor: sum("kind", "old_books") },
      { key: "overdue", label: "Overdue", amountMinor: overdue },
      { key: "not_due", label: "Not yet due", amountMinor: notDue },
    ];
  });
  return { rows, sides };
}

// ── Obligations ──────────────────────────────────────────────────────────────

async function obligationData(orgId: string) {
  const [bills, runs, crm, cs, records, expenses, loans, repayments] = await Promise.all([
    Bill.find({ organizationId: oid(orgId), status: { $nin: ["draft", "voided"] } }).select("billNumber vendorName billDate dueDate status currency totalMinor amountPaidMinor payments.paidOn payments.amountMinor").lean<any[]>(),
    PayrollRun.find({ organizationId: oid(orgId), status: { $in: LIVE_RUN } }).select("runNumber period currency lines._id lines.name lines.currency lines.payableMinor lines.status lines.departmentName lines.hrmsEmployeeId lines.deductions payments.paidOn payments.amountMinor payments.reversedAt payments.allocations adjustments").lean<any[]>(),
    CrmCommissionPayout.find({ organizationId: oid(orgId), state: { $in: ["approved", "paid"] } }).select("crmName month personName currency amountMinor state paidOn payrollRunId expenseId").lean<any[]>(),
    CsCommissionPayout.find({ organizationId: oid(orgId), state: { $in: ["approved", "paid"] } }).select("kind lastMonth personName currency amountMinor state paidOn payrollRunId expenseId").lean<any[]>(),
    CommissionRecord.find({ organizationId: oid(orgId), status: { $in: ["earned", "paid"] } }).select("salespersonName invoiceNumber commissionMinor status calculatedAt paidAt payrollRunId paidExpenseId").lean<any[]>(),
    Expense.find({ organizationId: oid(orgId), status: { $in: ["approved", "submitted"] }, "source.kind": { $nin: ["bill", "payroll"] } }).select("expenseNumber category subcategoryName description expenseDate dueDate paidOn totalMinor currency status").lean<any[]>(),
    Loan.find({ organizationId: oid(orgId), type: "taken" }).lean<any[]>(),
    LoanRepayment.find({ organizationId: oid(orgId) }).lean<any[]>(),
  ]);
  return { bills, runs, crm, cs, records, expenses, loans, repayments };
}
type OblData = Awaited<ReturnType<typeof obligationData>>;

const OBL_LAYOUT = [
  { key: "obl", title: "Outstanding obligations", lines: [
    { key: "bills", label: "Supplier bills (unpaid and part paid)" }, { key: "salaries", label: "Approved unpaid salaries" }, { key: "commission", label: "Approved / earned unpaid commission" },
    { key: "expenses", label: "Approved unpaid expenses" }, { key: "reimbursements", label: "Employee reimbursements payable (HRMS, waiting for finance)" }, { key: "loans", label: "Loans taken — principal outstanding" },
  ] },
  { key: "age", title: "Ageing (by due date)", lines: BANDS.map((b) => ({ key: b.key, label: b.label })) },
  { key: "info", title: "Indicative, not added in", lines: [{ key: "vat", label: "VAT, this month so far (output − input)" }], showTotal: false },
];

function obligationsOf(data: OblData, base: string, asOf: string, extra: { reimbursements: FPRow[]; vat: FPRow[] }) {
  const cut = endOf(asOf).getTime();
  const at = endOf(asOf);
  const cur = (c: unknown) => String(c || base).toUpperCase();
  const rows: FPRow[] = [];
  const push = (r: Omit<FPRow, "section" | "month" | "band" | "overdueDays" | "status"> & { status?: string }, dueDate: Date | null) => {
    const { band, overdue } = bandOf(dueDate, at);
    rows.push({ ...r, section: "obl", month: r.date.slice(0, 7), band, overdueDays: overdue, due: day(dueDate), status: r.status ?? (overdue > 0 ? `${overdue} days overdue` : "Not yet due") });
  };
  for (const b of data.bills) {
    if (new Date(b.billDate).getTime() > cut) continue;
    const total = Number(b.totalMinor) || 0;
    const cash = (b.payments ?? []).reduce((n: number, p: any) => n + (Number(p.amountMinor) || 0), 0);
    const paid = (b.payments ?? []).filter((p: any) => new Date(p.paidOn).getTime() <= cut).reduce((n: number, p: any) => n + (Number(p.amountMinor) || 0), 0);
    const credit = Math.max(0, (Number(b.amountPaidMinor) || 0) - cash); // vendor credits applied (undated)
    const owed = total - paid - credit;
    if (owed <= 0) continue;
    push({ id: String(b._id), date: day(b.billDate), number: b.billNumber, title: b.vendorName ?? "", detail: "Supplier bill", line: "bills", category: "Supplier bills", amountMinor: owed, currency: cur(b.currency), href: `/bills/${b._id}`, kind: "bill", originalMinor: total, settledMinor: paid, creditMinor: credit, status: paid ? "Part paid" : "Not paid" }, b.dueDate);
  }
  const onRuns = { crm: new Set<string>(), cs: new Set<string>(), records: new Set<string>() };
  for (const r of data.runs) for (const a of r.adjustments ?? []) {
    for (const id of a.crmPayoutIds ?? []) onRuns.crm.add(String(id));
    for (const id of a.csPayoutIds ?? []) onRuns.cs.add(String(id));
    for (const id of a.commissionRecordIds ?? []) onRuns.records.add(String(id));
  }
  for (const r of data.runs) {
    const end = payrollMonthEnd(r.period);
    if (end.getTime() > cut) continue;
    const paidBy = new Map<string, number>();
    for (const p of r.payments ?? []) {
      if (new Date(p.paidOn).getTime() > cut || (p.reversedAt && new Date(p.reversedAt).getTime() <= cut)) continue;
      for (const al of p.allocations ?? []) paidBy.set(String(al.lineId), (paidBy.get(String(al.lineId)) ?? 0) + (Number(al.amountMinor) || 0));
    }
    for (const l of r.lines ?? []) {
      const payable = Number(l.payableMinor) || 0;
      const paid = Math.min(payable, paidBy.get(String(l._id)) ?? 0);
      if (payable - paid <= 0) continue;
      push({ id: `${r._id}:${l._id}`, date: day(end), number: r.runNumber, title: l.name ?? "", detail: `Payroll for ${r.period}${l.status === "on_hold" ? " · on hold" : ""}`, line: "salaries", category: l.departmentName || "No department", amountMinor: payable - paid, currency: cur(l.currency || r.currency), href: `/payroll/${r._id}`, kind: "salary", originalMinor: payable, settledMinor: paid, creditMinor: 0, status: l.status === "on_hold" ? "On hold" : paid ? "Part paid" : "Not paid" }, end);
    }
  }
  for (const [which, list, monthOf] of [["crm", data.crm, (p: any) => p.month], ["cs", data.cs, (p: any) => p.lastMonth]] as const) {
    for (const p of list as any[]) {
      if (p.payrollRunId || onRuns[which].has(String(p._id))) continue; // in payroll
      const m = String((monthOf as (x: any) => string)(p) ?? "");
      if (!/^\d{4}-\d{2}$/.test(m)) continue;
      const end = payrollMonthEnd(m);
      if (end.getTime() > cut) continue;
      if (p.state === "paid" && (!p.paidOn || new Date(p.paidOn).getTime() <= cut)) continue;
      const amount = Number(p.amountMinor) || 0;
      push({ id: `${which}:${p._id}`, date: day(end), number: "", title: p.personName ?? "", detail: `${which === "crm" ? "CRM" : "CS"} commission earned ${m}`, line: "commission", category: which === "crm" ? "CRM commission" : "CS commission", amountMinor: amount, currency: cur(p.currency), href: which === "crm" ? "/commissions/crm" : "/commissions/cs", kind: "commission", originalMinor: amount, settledMinor: 0, creditMinor: 0, status: "Approved, not paid" }, end);
    }
  }
  for (const c of data.records) {
    if (c.payrollRunId || onRuns.records.has(String(c._id)) || new Date(c.calculatedAt).getTime() > cut) continue;
    if (c.status === "paid" && (!c.paidAt || new Date(c.paidAt).getTime() <= cut)) continue;
    const amount = Number(c.commissionMinor) || 0;
    push({ id: `rec:${c._id}`, date: day(c.calculatedAt), number: c.invoiceNumber ?? "", title: c.salespersonName ?? "", detail: `Commission on ${c.invoiceNumber}`, line: "commission", category: "Finance commission", amountMinor: amount, currency: base, href: "/commissions", kind: "commission", originalMinor: amount, settledMinor: 0, creditMinor: 0, status: "Earned, not paid" }, new Date(c.calculatedAt));
  }
  const commissionExpenses = new Set<string>([...data.crm, ...data.cs].filter((p: any) => p.expenseId).map((p: any) => String(p.expenseId)).concat(data.records.filter((r: any) => r.paidExpenseId).map((r: any) => String(r.paidExpenseId))));
  for (const e of data.expenses) {
    if (commissionExpenses.has(String(e._id)) || new Date(e.expenseDate).getTime() > cut) continue;
    if (e.paidOn && new Date(e.paidOn).getTime() <= cut) continue;
    const amount = Number(e.totalMinor) || 0;
    push({ id: String(e._id), date: day(e.expenseDate), number: e.expenseNumber ?? "", title: e.description ?? "", detail: [e.subcategoryName, e.status === "submitted" ? "waiting for approval" : ""].filter(Boolean).join(" · "), line: "expenses", category: e.category ?? "", amountMinor: amount, currency: cur(e.currency), href: `/expenses/${e._id}`, kind: "expense", originalMinor: amount, settledMinor: 0, creditMinor: 0, status: "Not paid" }, e.dueDate ?? e.expenseDate);
  }
  for (const r of extra.reimbursements) rows.push(r);
  for (const ln of data.loans) {
    if (new Date(ln.startDate).getTime() > cut) continue;
    const repaid = data.repayments.filter((p) => String(p.loanId) === String(ln._id) && new Date(p.paidOn).getTime() <= cut).reduce((n, p) => n + (Number(p.principalMinor) || 0), 0);
    const owed = (Number(ln.principalMinor) || 0) - repaid;
    if (owed <= 0) continue;
    push({ id: String(ln._id), date: day(ln.startDate), number: ln.loanNumber, title: ln.counterpartyName ?? "", detail: `Loan taken, ${ln.status}${ln.interestRate ? `, ${ln.interestRate}% interest (not accrued here)` : ""}`, line: "loans", category: "Loans", amountMinor: owed, currency: base, href: `/loans/${ln._id}`, kind: "loan", originalMinor: Number(ln.principalMinor) || 0, settledMinor: repaid, creditMinor: 0 }, ln.dueDate ? new Date(ln.dueDate) : null);
  }
  const banded = rows.map((r) => ({ ...r, section: "age", line: r.band! }));
  const all = [...rows, ...banded, ...extra.vat];
  const sides = sidesOf(all, base, OBL_LAYOUT, (sum, currency) => {
    const mine = rows.filter((r) => r.currency === currency);
    return [
      { key: "total", label: "Total recorded obligations", amountMinor: sum("obl"), strong: true },
      { key: "overdue", label: "Overdue", amountMinor: mine.filter((r) => (r.overdueDays ?? 0) > 0).reduce((n, r) => n + r.amountMinor, 0) },
      { key: "upcoming", label: "Not yet due (upcoming)", amountMinor: mine.filter((r) => r.band === "not_due").reduce((n, r) => n + r.amountMinor, 0) },
      { key: "original", label: "Original amount of these obligations", amountMinor: mine.reduce((n, r) => n + (r.originalMinor ?? 0), 0) },
      { key: "settled", label: "Settled on them", amountMinor: mine.reduce((n, r) => n + (r.settledMinor ?? 0), 0) },
      { key: "credits", label: "Credit adjustments on them", amountMinor: mine.reduce((n, r) => n + (r.creditMinor ?? 0), 0) },
    ];
  });
  return { rows, sides };
}

/** HR-approved reimbursements waiting for finance — live from HRMS, now only (HRMS keeps no history for a past date). */
async function reimbursementRows(orgId: string, base: string, asOf: string, warnings: string[]): Promise<FPRow[]> {
  if (asOf < new Date().toISOString().slice(0, 10)) { warnings.push("Reimbursements waiting in HRMS can only be read as they stand now, so a past date leaves them out."); return []; }
  try {
    const list = await reimbursementsWaiting(orgId);
    return list.filter((r: any) => !r.expense).map((r: any) => {
      const date = day(r.hrReviewedAt ?? r.createdAt);
      const amount = Math.round((Number(r.amount) || 0) * 100);
      return { id: `reimb:${r._id}`, date, month: date.slice(0, 7), number: "", title: r.employee?.name ?? "", detail: [r.title, r.category].filter(Boolean).join(" · "), section: "obl", line: "reimbursements", category: "Reimbursements", status: "Approved by HR, not paid", amountMinor: amount, currency: String(r.currency || base).toUpperCase(), href: "/reimbursements", kind: "reimbursement", band: "no_due", overdueDays: 0, due: "", originalMinor: amount, settledMinor: 0, creditMinor: 0 } satisfies FPRow;
    });
  } catch (e) {
    warnings.push(`Reimbursements waiting in HRMS could not be read (${(e as Error).message}); they are not in the obligations.`);
    return [];
  }
}

// ── Employee advances ────────────────────────────────────────────────────────

const ADV_LAYOUT = [
  { key: "issued", title: "Advances issued", lines: [{ key: "hrms", label: "Paid by finance from HRMS requests" }, { key: "typed", label: "Typed in finance" }, { key: "old_books", label: "Imported from old books" }] },
  { key: "recovered", title: "Recovered from salary (finance payroll runs)", lines: [{ key: "salary", label: "Salary advance deductions" }] },
  { key: "outstanding", title: "Outstanding — calculable (HRMS advances less recoveries), per employee", lines: [] as { key: string; label: string }[] },
  { key: "earlier", title: "Recovered more than finance issued (repaying advances given before finance)", lines: [] as { key: string; label: string }[] },
  { key: "other_loans", title: "Other employee loan deductions (no matching amount given in finance)", lines: [{ key: "other", label: "Loan repayment deductions (e.g. visa loans)" }], showTotal: true },
];

async function advancesOf(orgId: string, base: string, asOf: string, warnings: string[]) {
  const cut = endOf(asOf).getTime();
  const [expenses, runs] = await Promise.all([
    Expense.find({ organizationId: oid(orgId), category: "employee_advances", status: { $in: ["approved", "submitted"] } }).select("expenseNumber description expenseDate paidOn totalMinor currency notes source.kind source.key subcategoryName").lean<any[]>(),
    PayrollRun.find({ organizationId: oid(orgId), status: { $in: LIVE_RUN } }).select("runNumber period currency lines.name lines.currency lines.hrmsEmployeeId lines.employeeCode lines.deductions").lean<any[]>(),
  ]);
  // Who each HRMS advance was for, from HRMS's own record (finance's expense only names them in its text).
  const who = new Map<string, { id: string; name: string; code: string }>();
  try {
    for (const r of await advanceHistory(orgId, "approved")) if (r.employee?._id) who.set(`hrms-advance:${r.hrmsOrgId}:${r._id}`, { id: r.employee._id, name: r.employee.name, code: r.employee.employeeCode ?? "" });
  } catch (e) {
    warnings.push(`HRMS's record of advances could not be read (${(e as Error).message}); employees are named from finance's own text, and outstanding amounts per employee may not match up.`);
  }
  const rows: FPRow[] = [];
  const issuedBy = new Map<string, { name: string; currency: string; issued: number; recovered: number }>();
  for (const e of expenses) {
    const when = e.paidOn ?? e.expenseDate;
    if (new Date(when).getTime() > cut) continue;
    const kind = e.source?.kind === "hrms_advance" ? "hrms" : e.source?.kind === "import" ? "old_books" : "typed";
    const person = kind === "hrms" ? who.get(String(e.source?.key)) : undefined;
    const nameFromText = String(e.notes ?? "").match(/Employee: ([^\n(]+)/)?.[1]?.trim() || String(e.description ?? "").split("—")[1]?.trim() || "";
    const amount = Number(e.totalMinor) || 0;
    const currency = String(e.currency || base).toUpperCase();
    if (kind === "hrms") {
      const k = person?.id ?? `name:${nameFromText}`;
      const t = issuedBy.get(k) ?? { name: person?.name ?? nameFromText, currency, issued: 0, recovered: 0 };
      t.issued += amount; issuedBy.set(k, t);
    }
    const date = day(when);
    rows.push({ id: String(e._id), date, month: date.slice(0, 7), number: e.expenseNumber ?? "", title: person?.name ?? nameFromText ?? e.description ?? "", detail: [e.subcategoryName, kind === "old_books" ? "recoveries before finance payroll are not recorded" : ""].filter(Boolean).join(" · "), section: "issued", line: kind, category: kind === "hrms" ? "HRMS advance" : kind === "old_books" ? "Old books" : "Typed", status: "Issued", amountMinor: amount, currency, href: `/expenses/${e._id}`, kind });
  }
  for (const r of runs) {
    const end = payrollMonthEnd(r.period);
    if (end.getTime() > cut) continue;
    for (const l of r.lines ?? []) {
      const currency = String(l.currency || r.currency || base).toUpperCase();
      for (const dd of l.deductions ?? []) {
        const label = String(dd.label ?? "");
        if (!/advance|loan/i.test(label)) continue;
        const salary = /salary advance/i.test(label);
        const amount = Number(dd.amountMinor) || 0;
        if (salary) {
          const t = issuedBy.get(String(l.hrmsEmployeeId)) ?? issuedBy.get(`name:${l.name}`);
          if (t) t.recovered += amount;
          else issuedBy.set(String(l.hrmsEmployeeId), { name: l.name ?? "", currency, issued: 0, recovered: amount });
        }
        rows.push({ id: `${r._id}:${l.hrmsEmployeeId}:${label}`, date: day(end), month: r.period, number: r.runNumber, title: l.name ?? "", detail: `${label} — payroll ${r.period}`, section: salary ? "recovered" : "other_loans", line: salary ? "salary" : "other", category: salary ? "Salary advance recovery" : "Other loan deduction", status: "Deducted", amountMinor: salary ? -amount : amount, currency, href: `/payroll/${r._id}`, kind: "recovery" });
      }
    }
  }
  const outstandingRows: FPRow[] = [...issuedBy.entries()].filter(([, t]) => t.issued - t.recovered !== 0).map(([k, t]) => ({
    id: `out:${k}`, date: asOf, month: asOf.slice(0, 7), number: "", title: t.name, detail: `issued ${(t.issued / 100).toFixed(2)}, recovered ${(t.recovered / 100).toFixed(2)}${t.issued === 0 ? " — recovered with no advance paid through finance (an earlier advance)" : ""}`,
    section: t.issued - t.recovered > 0 ? "outstanding" : "earlier", line: k, category: t.issued - t.recovered > 0 ? "Outstanding" : "Recovered beyond finance's advances", status: t.issued - t.recovered > 0 ? "Owed by the employee" : "Recovered more than issued here", amountMinor: t.issued - t.recovered, currency: t.currency, href: "/advances", kind: "outstanding",
  }));
  const layout = ADV_LAYOUT.map((s) => (s.key === "outstanding" || s.key === "earlier" ? { ...s, lines: outstandingRows.filter((r) => r.section === s.key).map((r) => ({ key: r.line, label: r.title || "Unnamed" })) } : s));
  const all = [...rows, ...outstandingRows];
  const sides = sidesOf(all, base, layout, (sum) => [
    { key: "issued_hrms", label: "Issued through finance from HRMS", amountMinor: sum("issued", "hrms") },
    { key: "recovered", label: "Recovered from salary in finance payroll", amountMinor: -sum("recovered") },
    { key: "outstanding", label: "Outstanding (calculable part)", amountMinor: sum("outstanding"), strong: true },
    { key: "earlier", label: "Recovered beyond finance's advances (older advances being repaid)", amountMinor: -sum("earlier") },
    { key: "unknown", label: "Issued with recoveries not recorded (old books and typed) — outstanding not calculable", amountMinor: sum("issued", "old_books") + sum("issued", "typed") },
  ]);
  return { rows: all, sides };
}

// ── The reports ──────────────────────────────────────────────────────────────

const RECORDED = "Bank balances are system-recorded — opening balance plus the bank lines entered in finance — and have not been independently reconciled to bank statements unless shown as confirmed. Many accounts started at a zero opening balance, so a balance can be incomplete; an account below zero means money out was recorded without the money in.";
const NOT_SECURED = "Receivables are what is still due on issued invoices and on enrolment balances. They are not presented as legally enforceable or certain to be collected: nothing is written off and no expected credit loss is worked out.";
const HRMS_NOW = "HRMS data (reimbursements waiting, and which employee each advance was for) can only be read as it stands now; a past date or an earlier month-end leaves it out.";
const NOTES: Record<FPReport, string[]> = {
  cashflow: [
    "Cash Flow from finance's bank lines: each line classed by the record it is matched to, or its own category. Transfers between own accounts are out of money in and out but stay in each account's balance; a PSP settlement moves money by such a transfer, so a payment received through a gateway is counted once.",
    "Office Setup (furniture, computers, equipment, renovation) is investing; repairs, interest and staff advances are operating. Loan receipts and capital contributions have no record type in finance, so money in of that kind appears as not identified.",
    "Lines matched to no record (not identified) and lines marked duplicate are shown apart and still counted, as they are in the balances. No balancing entry is made: any difference in the check line is disclosed.",
    RECORDED,
  ],
  cash: [
    RECORDED,
    "Estimated available cash = bank accounts + petty cash as recorded; an account below zero is flagged and still counted. PSP balances are money waiting to settle, kept apart. Restricted funds are not recorded in finance.",
  ],
  receivables: [
    "As of the date: each invoice issued by then, less the payments made by then and the credit applied by then. Payments and credits after the date are not taken off.",
    NOT_SECURED,
    "Invoices issued and enrolment balances (rolling 29-day instalment) are shown as due; pro-forma balances are conditional future student instalments not yet tax-invoiced; old-books imports (mostly over a year overdue) are kept apart and out of the net position.",
    "Historical limitation: a void invoice is left out entirely — finance records no date for voiding, so one voided after the date is not shown as owed at that date.",
  ],
  obligations: [
    "Recorded obligations only — not a complete statutory liability balance: no accruals, no employer costs, no interest accrued on loans. An outstanding obligation is not necessarily due now: see its due date and the ageing.",
    "Salaries are each person's payable in approved runs less what was paid by the date; commission is approved or earned and not in a payroll run (in a run it is in salaries, never twice); expenses are those not yet paid by the date.",
    "Historical limitations: vendor credits applied to bills are not dated, so they are taken off at every date; payroll payments count from the day paid and reversals from the day reversed.",
    HRMS_NOW,
    "VAT is shown as an indication for the month and is excluded from the obligations: finance's VAT figures are a period's output less input, not a confirmed liability balance.",
  ],
  advances: [
    "Advances issued are expenses under Employee Advances Receivable; recoveries are payroll deductions labelled \"salary advance\" on finance's payroll runs (HRMS does not mark deduction types).",
    "Outstanding can be worked out only for advances paid through finance from HRMS. Advances imported from old books or typed in finance were recovered, if at all, before payroll ran in finance, so their outstanding balance cannot be calculated and is not included. Proposed minimum enhancement (for approval): HRMS to report what it has recovered on each advance.",
    HRMS_NOW,
  ],
  position: [
    "Management Financial Position — not a statutory balance sheet: no ledger, no fixed assets, no equity, no accruals.",
    RECORDED,
    NOT_SECURED + " Pro-forma balances (conditional future instalments) are shown apart — the net is given with and without them — and old-books balances are left out. Uncollected receivables are never in available cash.",
    "Obligations are recorded ones and are not all due now. Indicative VAT is not included. Employee advances count only the part that can be calculated.",
    "Available cash less obligations = estimated available cash (bank + petty cash) less every approved unpaid obligation recorded, whatever its due date.",
    HRMS_NOW,
  ],
};

function warningsFor(accounts: AccountAt[] | null, asOf: string): string[] {
  if (!accounts) return [];
  const w: string[] = [];
  const neg = accounts.filter((a) => a.balanceMinor < 0);
  if (neg.length) w.push(`${neg.length} account(s) below zero as of ${asOf} (${neg.map((a) => a.name).join(", ")}): money out recorded without the money in.`);
  const unrec = accounts.filter((a) => !a.reconciledLines && a.lines > 0).length;
  if (unrec) w.push(`${unrec} account(s) have never been reconciled to a bank statement: their balances are system-recorded only.`);
  const later = accounts.filter((a) => a.linesAfter > 0 && asOf >= new Date().toISOString().slice(0, 10));
  if (later.length) w.push(`${later.length} account(s) have lines dated in the future (${later.map((a) => a.name).join(", ")}).`);
  const drift = accounts.filter((a) => a.storedMinor !== a.allLinesMinor);
  if (drift.length) w.push(`${drift.length} account(s) whose stored balance differs from opening + lines: ${drift.map((a) => `${a.name} ${((a.storedMinor - a.allLinesMinor) / 100).toFixed(2)}`).join(", ")}.`);
  return w;
}

/** One report: its figures per currency, month by month, notes and data warnings, and every record behind it. */
export async function financialReport(orgId: string, report: FPReport, from: string, to: string) {
  const base = (await baseCurrencyOf(orgId)).toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const asOf = to > today ? today : to;
  const warnings: string[] = [];
  let rows: FPRow[] = [];
  let sides: FPSide[] = [];
  let months: { month: string; sides: FPSide[] }[] = [];

  if (report === "cashflow" || report === "cash") {
    const data = await bankData(orgId);
    if (report === "cashflow") {
      ({ rows, sides } = cashflowOf(data, base, from, to));
      months = monthsOf(from, to).map((m) => ({ month: m.month, sides: cashflowOf(data, base, m.from, m.to).sides }));
    } else {
      const now = cashOf(data, base, asOf);
      ({ rows, sides } = now);
      months = monthEnds(from, asOf).map((end) => ({ month: end.slice(0, 7), sides: cashOf(data, base, end).sides }));
    }
    warnings.push(...warningsFor(accountsAt(data, asOf), asOf));
  } else if (report === "receivables") {
    const data = await receivableData(orgId, asOf);
    ({ rows, sides } = receivablesOf(data, base, asOf));
    months = monthEnds(from, asOf).map((end) => ({ month: end.slice(0, 7), sides: receivablesOf(data, base, end).sides }));
    const noDue = rows.filter((r) => r.section === "kind" && r.band === "no_due").length;
    if (noDue) warnings.push(`${noDue} open invoice(s) have no valid due date.`);
  } else if (report === "obligations") {
    const data = await obligationData(orgId);
    const vat = await vatRow(orgId, base, asOf);
    const reimb = await reimbursementRows(orgId, base, asOf, warnings);
    ({ rows, sides } = obligationsOf(data, base, asOf, { reimbursements: reimb, vat }));
    months = monthEnds(from, asOf).map((end) => ({ month: end.slice(0, 7), sides: obligationsOf(data, base, end, { reimbursements: end === asOf ? reimb : [], vat: [] }).sides }));
  } else if (report === "advances") {
    ({ rows, sides } = await advancesOf(orgId, base, asOf, warnings));
  } else {
    const [bank, rec, obl] = await Promise.all([bankData(orgId), receivableData(orgId, asOf), obligationData(orgId)]);
    const reimb = await reimbursementRows(orgId, base, asOf, warnings);
    const adv = await advancesOf(orgId, base, asOf, warnings);
    const build = (d: string, withReimb: boolean) => positionOf(base, cashOf(bank, base, d), receivablesOf(rec, base, d), obligationsOf(obl, base, d, { reimbursements: withReimb ? reimb : [], vat: [] }), d === asOf ? adv : null);
    ({ rows, sides } = build(asOf, true));
    months = monthEnds(from, asOf).map((end) => ({ month: end.slice(0, 7), sides: build(end, end === asOf).sides }));
    warnings.push(...warningsFor(accountsAt(bank, asOf), asOf));
    if (months.length > 1) warnings.push("Earlier month-ends leave out employee advances and HRMS reimbursements, which can only be read as they stand now.");
  }
  return { report, currency: base, from, to, asOf, sides, months, notes: NOTES[report], warnings, recordCount: rows.length, rows };
}

async function vatRow(orgId: string, base: string, asOf: string): Promise<FPRow[]> {
  const from = `${asOf.slice(0, 7)}-01`;
  const vat = await getVATReport(orgId, from, asOf, base);
  return [{ id: `vat:${from}`, date: asOf, month: asOf.slice(0, 7), number: "", title: `VAT ${from} to ${asOf}`, detail: `output ${(vat.outputTaxMinor / 100).toFixed(2)} − input ${(vat.inputTaxMinor / 100).toFixed(2)}; indicative, not added`, section: "info", line: "vat", category: "VAT", status: "Indicative", amountMinor: vat.netPayableMinor, currency: base, href: "/reports/vat" }];
}

function positionOf(base: string, cash: ReturnType<typeof cashOf>, rec: ReturnType<typeof receivablesOf>, obl: ReturnType<typeof obligationsOf>, adv: Awaited<ReturnType<typeof advancesOf>> | null) {
  const rows: FPRow[] = [];
  const take = (src: FPRow[], section: string, line: string, pick: (r: FPRow) => boolean, sign = 1) => { for (const r of src.filter(pick)) rows.push({ ...r, section, line, amountMinor: sign * r.amountMinor }); };
  take(cash.rows, "have", "cash", (r) => r.section === "bank" || r.section === "petty");
  take(cash.rows, "have", "psp", (r) => r.section === "psp");
  take(rec.rows, "have", "receivables", (r) => r.section === "kind" && (r.line === "invoice" || r.line === "enrolment"));
  if (adv) take(adv.rows, "have", "advances", (r) => r.section === "outstanding" && r.amountMinor > 0);
  take(rec.rows, "apart", "proforma", (r) => r.section === "kind" && r.line === "proforma");
  take(rec.rows, "apart", "old_books", (r) => r.section === "kind" && r.line === "old_books");
  for (const k of ["bills", "salaries", "commission", "expenses", "reimbursements", "loans"]) take(obl.rows, "owe", k, (r) => r.section === "obl" && r.line === k);
  const sides = sidesOf(rows, base, [
    { key: "have", title: "What the organization has and is owed", lines: [{ key: "cash", label: "Cash and bank balances (estimated available)" }, { key: "psp", label: "Pending PSP settlements" }, { key: "receivables", label: "Customer receivables — issued invoices and enrolment balances" }, { key: "advances", label: "Employee advances outstanding (calculable part)" }] },
    { key: "owe", title: "What the organization owes (recorded)", lines: [{ key: "bills", label: "Supplier payables" }, { key: "salaries", label: "Unpaid salaries" }, { key: "commission", label: "Unpaid commission" }, { key: "expenses", label: "Unpaid approved expenses" }, { key: "reimbursements", label: "Reimbursements payable" }, { key: "loans", label: "Loans taken (principal)" }] },
    { key: "apart", title: "Shown apart, not in the net", lines: [{ key: "proforma", label: "Pro-forma balances (conditional future instalments)" }, { key: "old_books", label: "Old-books receivables" }] },
  ], (sum) => [
    { key: "net", label: "Net recorded financial position", amountMinor: sum("have") - sum("owe"), strong: true },
    { key: "net_with_proforma", label: "…with pro-forma balances", amountMinor: sum("have") - sum("owe") + sum("apart", "proforma") },
    { key: "available_less", label: "Available cash less every approved unpaid obligation", amountMinor: sum("have", "cash") - sum("owe"), strong: true },
  ]);
  return { rows, sides };
}

/** The records behind one figure: `line` is "<section>:<line>", a section key, or "all". */
export function linesOf(rows: FPRow[], line: string): FPRow[] {
  if (!line || line === "all") return rows;
  const [section, key] = line.split(":");
  return rows.filter((r) => r.section === section && (key === undefined || r.line === key));
}
