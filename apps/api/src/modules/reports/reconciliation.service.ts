import { Types } from "mongoose";
import { Invoice } from "../invoice/invoice.model";
import { CreditNote } from "../credit-note/credit-note.model";
import { Bill } from "../bill/bill.model";
import { VendorCredit } from "../vendor-credit/vendor-credit.model";
import { Expense } from "../expense/expense.model";
import { PayrollRun } from "../payroll/payroll-run.model";
import { payrollMonthEnd } from "../payroll/payroll-month";
import { CommissionRecord } from "../commission/commission-record.model";
import { CrmCommissionPayout } from "../crm-commission/crm-commission-payout.model";
import { CsCommissionPayout } from "../cs-commission/cs-commission-payout.model";
import { ReconciliationSession } from "../banking/reconciliation.model";
import { PspSettlement } from "../psp-settlement/psp-settlement.model";
import { baseCurrencyOf } from "./reports.service";
import { accountsAt, advancesOf, bankData, sidesOf, type FPRow, type FPSide, type FPTotal } from "./financial-position.service";

/*
 * Financial reconciliation and data integrity (Phase 5, 2026-11-27) — read-only reports beside banking's own
 * reconciliation screens, built from records finance already keeps: bank lines and reconciliation sessions (with their
 * statement checks), PSP settlements, invoices and their payments, credit notes, bills, vendor credits, expenses,
 * payroll runs, commission payouts and records, advances, and the old-books imports.
 *
 *   bank        each account: system-recorded balance, last statement and its difference, outstanding deposits and
 *               payments, what the statement has and finance lacks (and the reverse), unmatched lines, flags.
 *   psp         each gateway: collected, charges and their VAT, expected net, settled to the bank, pending and its
 *               age, settlement delay, differences, possible duplicate settlements.
 *   invoices    payments against bank lines and the other way round, references, overpayments, balances, voids,
 *               credits, currencies, receipts allocated to nothing.
 *   expenses    bills and their mirrors, bill payments and expenses without a bank line, possible duplicates, missing
 *               references, vendor credits, expense VAT, balance-sheet-like categories counted in the P&L.
 *   payroll     obligation, payments, reversals, outstanding, advance deductions, commission by state, possible
 *               overlap of typed commission with payouts, payroll runs left unpaid.
 *   advances    Phase 4's advances and their discrepancies.
 *   historical  old-books records apart from live ones, opening balances, imports overlapping live records.
 *   exceptions  every item above that needs action, once each, with severity, status and the action to take.
 *
 * Approved 2026-11-27 (as recommended): no HRMS change in this phase; cutover 1 Nov 2026 proposed to management;
 * exception status worked out each time (confirmed / suspected / missing information), nothing stored; a possible
 * duplicate expense = same organization, date, amount and category; severity as below. Nothing here writes.
 */

export type RCReport = "bank" | "psp" | "invoices" | "expenses" | "payroll" | "advances" | "historical" | "exceptions" | "summary";
export const RC_REPORTS: RCReport[] = ["bank", "psp", "invoices", "expenses", "payroll", "advances", "historical", "exceptions", "summary"];
export type Severity = "critical" | "high" | "medium" | "low";
/** "open": a statement figure not yet verified — an open reconciliation difference, never a confirmed loss (Phase 7). */
export type Confidence = "confirmed" | "suspected" | "missing" | "open";
/** A record behind a figure — and, when it needs action, the exception it is. */
export type RCRow = FPRow & { severity?: Severity; confidence?: Confidence; exception?: string; module?: string; action?: string; ageDays?: number; key?: string };

/** The financial cutover proposed to management (2026-11-27): live records from here; old books before it. */
export const CUTOVER = "2026-11-01";
const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };
const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };
const CONFIDENCE_LABEL: Record<Confidence, string> = { confirmed: "Confirmed discrepancy", suspected: "Suspected", missing: "Missing information", open: "Open reconciliation difference" };
const oid = (id: string) => new Types.ObjectId(id);
const day = (d: unknown) => (d ? new Date(d as Date).toISOString().slice(0, 10) : "");
const DAY = 86_400_000;
const isOld = (src: unknown) => src === "old_books" || src === "old-books";
const cur = (c: unknown, base: string) => String(c || base).toUpperCase();

function row(base: string, r: Partial<RCRow> & { id: string; date: string; section: string; line: string; amountMinor: number }): RCRow {
  const date = r.date || "";
  return { number: "", title: "", detail: "", category: "", status: "", currency: base, href: "", ...r, month: date.slice(0, 7) } as RCRow;
}
function flag(r: RCRow, exception: string, severity: Severity, confidence: Confidence, module: string, action: string, today: string): RCRow {
  return { ...r, exception, severity, confidence, module, action, status: r.status || CONFIDENCE_LABEL[confidence], ageDays: r.date ? Math.max(0, Math.floor((Date.parse(today) - Date.parse(r.date)) / DAY)) : 0 };
}

// ── Loaders (once per request) ───────────────────────────────────────────────

async function load(orgId: string) {
  const org = oid(orgId);
  const [bank, sessions, invoices, notes, bills, vendorCredits, expenses, runs, crm, cs, records, settlements] = await Promise.all([
    bankData(orgId),
    ReconciliationSession.find({ organizationId: org }).lean<any[]>(),
    Invoice.find({ organizationId: org, status: { $ne: "draft" } }).select("invoiceNumber customerName status currency totalMinor amountPaidMinor balanceMinor issueDate external.source proforma payments._id payments.amountMinor payments.paidOn payments.reference payments.receiptNumber payments.bankAccountId payments.bankTransactionId payments.method payments.original payments.bankCurrency").lean<any[]>(),
    CreditNote.find({ organizationId: org, status: { $in: ["issued", "applied"] } }).select("creditNoteNumber invoiceId amountAppliedMinor applications").lean<any[]>(),
    Bill.find({ organizationId: org, status: { $nin: ["draft"] } }).select("billNumber vendorName billDate status currency totalMinor amountPaidMinor expenseId payments._id payments.amountMinor payments.paidOn payments.reference payments.bankTransactionId payments.method").lean<any[]>(),
    VendorCredit.find({ organizationId: org, status: { $in: ["issued", "applied"] } }).select("creditNumber vendorName issueDate currency totalMinor amountAppliedMinor status").lean<any[]>(),
    Expense.find({ organizationId: org, status: { $in: ["approved", "submitted"] } }).select("expenseNumber category categoryName subcategoryName description expenseDate paidOn totalMinor taxMinor currency status paymentMethod reference bankTransactionId source.kind source.key").lean<any[]>(),
    PayrollRun.find({ organizationId: org }).select("runNumber period status currency lines._id lines.name lines.currency lines.payableMinor lines.amountPaidMinor lines.status lines.deductions payments.paymentId payments.amountMinor payments.paidOn payments.currency payments.reversedAt payments.bankTransactionId payments.expenseId adjustments").lean<any[]>(),
    CrmCommissionPayout.find({ organizationId: org }).select("crmName month personName currency amountMinor state paidOn payrollRunId expenseId").lean<any[]>(),
    CsCommissionPayout.find({ organizationId: org }).select("kind lastMonth personName currency amountMinor state paidOn payrollRunId expenseId").lean<any[]>(),
    CommissionRecord.find({ organizationId: org }).select("salespersonName invoiceNumber commissionMinor status calculatedAt paidAt payrollRunId paidExpenseId").lean<any[]>(),
    PspSettlement.find({ organizationId: org }).lean<any[]>(),
  ]);
  const lineById = new Map(bank.lines.map((l) => [String(l._id), l]));
  return { bank, sessions, invoices, notes, bills, vendorCredits, expenses, runs, crm, cs, records, settlements, lineById };
}
type Data = Awaited<ReturnType<typeof load>>;

// ── 1. Bank ──────────────────────────────────────────────────────────────────

function bankOf(d: Data, base: string, asOf: string, today: string) {
  const rows: RCRow[] = [];
  const accounts = accountsAt(d.bank, asOf);
  const cut = Date.parse(`${asOf}T23:59:59.999Z`);
  for (const a of accounts) {
    if (!a.lines && !a.opening) continue;
    const mine = d.sessions.filter((s) => String(s.accountId) === a.id && new Date(s.statementDate).getTime() <= cut).sort((x, y) => +new Date(y.statementDate) - +new Date(x.statementDate));
    const latest = mine[0];
    const completed = mine.find((s) => s.status === "completed");
    rows.push(row(a.currency, {
      id: `acct:${a.id}`, date: a.lastLine || a.openingDate, section: "balances", line: a.id, amountMinor: a.balanceMinor, title: a.name, number: a.type, category: a.type, account: a.name, href: `/banking/${a.id}`,
      detail: [`running balance ${a.storedMinor === a.allLinesMinor ? "correct (opening + lines)" : `out of step by ${((a.storedMinor - a.allLinesMinor) / 100).toFixed(2)}`}`, completed ? `reconciled to a statement on ${day(completed.statementDate)}` : "never reconciled to a statement", `${a.reconciledLines} of ${a.lines} lines reconciled`].join(" · "),
      status: completed ? "Reconciled" : "Not reconciled",
    }));
    if (a.storedMinor !== a.allLinesMinor) rows.push(flag(row(a.currency, { id: `drift:${a.id}`, date: asOf, section: "flags", line: "drift", amountMinor: a.storedMinor - a.allLinesMinor, title: a.name, account: a.name, category: "Stored balance out of step", href: `/banking/${a.id}` }), "Stored balance differs from opening + lines", "critical", "confirmed", "Banking", "Recalculate the account's running balance and find the line that moved it.", today));
    if (latest) {
      rows.push(flag(row(a.currency, {
        id: `sess:${latest._id}`, date: day(latest.statementDate), section: "differences", line: a.id, amountMinor: Number(latest.differenceMinor) || 0, title: a.name, account: a.name, category: latest.status === "completed" ? "Completed reconciliation" : "Open reconciliation",
        detail: `statement ${(Number(latest.statementBalanceMinor) / 100).toFixed(2)} on ${day(latest.statementDate)} against system ${(Number(latest.closingBookBalanceMinor) / 100).toFixed(2)}${latest.statementCheck?.summary ? ` · statement check: ${latest.statementCheck.summary.matched} matched, ${latest.statementCheck.summary.notInBooks} not in finance, ${latest.statementCheck.summary.notOnStatement} not on the statement` : ""}`,
        href: `/banking/${a.id}/reconcile`, status: latest.status === "completed" ? "Completed" : "Open",
      }), "Reconciliation difference", Number(latest.differenceMinor) ? "high" : "low", Number(latest.differenceMinor) ? "open" : "missing", "Banking", Number(latest.differenceMinor) ? "Check the statement balance typed in the session, then the lines it does not match." : "Complete the reconciliation in Banking.", today));
      // Outstanding up to the statement date: lines in finance not yet ticked as on the statement.
      const sCut = new Date(latest.statementDate).getTime();
      for (const l of d.bank.lines) {
        if (String(l.accountId) !== a.id || l.isReconciled || new Date(l.date).getTime() > sCut || (l.transfer && (l.transfer as { id?: unknown }).id)) continue;
        rows.push(row(a.currency, { id: `out:${l._id}`, date: day(l.date), section: "outstanding", line: l.amountMinor > 0 ? "deposits" : "payments", amountMinor: l.amountMinor, title: l.description ?? "", account: a.name, category: l.amountMinor > 0 ? "Outstanding deposit" : "Outstanding payment", href: `/banking/${a.id}`, status: "Not on a statement yet" }));
      }
      const check = latest.statementCheck;
      for (const cl of check?.lines ?? []) {
        if (cl.status === "matched") continue;
        rows.push(flag(row(a.currency, { id: `stmt:${latest._id}:${cl.index}`, date: cl.date, section: "not_in_books", line: cl.status, amountMinor: cl.status === "amount_differs" ? Number(cl.differenceMinor) || 0 : Number(cl.amountMinor) || 0, title: cl.description ?? "", number: cl.reference ?? "", account: a.name, category: cl.status === "amount_differs" ? "Amount differs from finance" : "On the statement, not in finance", href: `/banking/${a.id}/reconcile` }), "Bank statement line missing from finance", "high", "open", "Banking", "Record it from the reconciliation screen (or find the matching record).", today));
      }
      for (const b of check?.notOnStatement ?? []) {
        rows.push(flag(row(a.currency, { id: `nos:${latest._id}:${b.id}`, date: b.date, section: "not_on_statement", line: b.amountMinor > 0 ? "in" : "out", amountMinor: b.amountMinor, title: b.description ?? "", number: b.reference ?? "", account: a.name, category: "In finance, not on the statement", href: `/banking/${a.id}/reconcile` }), "System transaction missing from the bank statement", "high", "open", "Banking", "Check whether it cleared later, was entered twice, or belongs to another account.", today));
      }
    } else if (a.lines) {
      rows.push(flag(row(a.currency, { id: `norec:${a.id}`, date: a.lastLine || asOf, section: "flags", line: "never_reconciled", amountMinor: 0, title: a.name, account: a.name, category: "Never reconciled", href: `/banking/${a.id}/reconcile` }), "Account never reconciled to a statement", "medium", "missing", "Banking", "Reconcile the account against its bank statement.", today));
    }
    if (a.balanceMinor < 0) rows.push(flag(row(a.currency, { id: `neg:${a.id}`, date: asOf, section: "flags", line: "negative", amountMinor: a.balanceMinor, title: a.name, account: a.name, category: "Below zero", href: `/banking/${a.id}` }), "Negative bank balance", "medium", "missing", "Banking", "Find the money in that is missing, or the correct opening balance.", today));
    if (!a.opening && a.lines) rows.push(flag(row(a.currency, { id: `open:${a.id}`, date: a.openingDate, section: "flags", line: "zero_opening", amountMinor: 0, title: a.name, account: a.name, category: "Opening balance 0, not verified", href: `/banking/${a.id}` }), "Opening balance missing or unverified", "medium", "missing", "Banking", `Confirm the balance on ${a.openingDate} from the bank statement.`, today));
  }
  for (const l of d.bank.lines) {
    if (new Date(l.date).getTime() > cut && day(l.date) > today) {
      const acc = d.bank.accById.get(String(l.accountId));
      rows.push(flag(row(cur(acc?.currency, base), { id: `fut:${l._id}`, date: day(l.date), section: "flags", line: "future", amountMinor: l.amountMinor, title: l.description ?? "", account: acc?.accountName ?? "", category: "Dated in the future", href: `/banking/${l.accountId}` }), "Future-dated bank transaction", "medium", "suspected", "Banking", "Correct the line's date.", today));
    }
    if (new Date(l.date).getTime() > cut) continue;
    const acc = d.bank.accById.get(String(l.accountId));
    const currency = cur(acc?.currency, base);
    if (l.status === "duplicate") rows.push(flag(row(currency, { id: `dup:${l._id}`, date: day(l.date), section: "flags", line: "duplicate", amountMinor: l.amountMinor, title: l.description ?? "", account: acc?.accountName ?? "", category: "Marked duplicate (still in the balance)", href: `/banking/${l.accountId}` }), "Duplicate-marked bank transaction", "high", "suspected", "Banking", "Delete it if it is a real duplicate (the balance follows), or click \"Not a duplicate\".", today));
    else if (!(l.matches ?? []).length && !(l.transfer && (l.transfer as { id?: unknown }).id) && l.status !== "excluded") {
      rows.push(flag(row(currency, { id: `um:${l._id}`, date: day(l.date), section: "unmatched", line: l.amountMinor > 0 ? "in" : "out", amountMinor: l.amountMinor, title: l.description ?? "", number: l.reference ?? "", account: acc?.accountName ?? "", category: l.category ? `Categorised (${l.category}), no record` : "Matched to no record", href: `/banking/${l.accountId}` }), l.amountMinor > 0 ? "Bank receipt not allocated to any record" : "Bank payment not linked to any record", "medium", "missing", "Banking", "Match it to its invoice, bill, expense or payroll payment.", today));
    }
  }
  const sides = sidesOf(rows, base, [
    { key: "balances", title: "System-recorded balances (opening + lines; a correct running balance is not a reconciled one)", lines: accounts.map((a) => ({ key: a.id, label: `${a.name} (${a.type})` })) },
    { key: "differences", title: "Latest reconciliation per account: statement − system difference", lines: accounts.map((a) => ({ key: a.id, label: a.name })) },
    { key: "outstanding", title: "Outstanding up to each statement date (in finance, not yet on a statement)", lines: [{ key: "deposits", label: "Outstanding deposits" }, { key: "payments", label: "Outstanding payments" }] },
    { key: "not_in_books", title: "On the bank statement, missing from finance", lines: [{ key: "not_in_books", label: "Statement lines not in finance" }, { key: "amount_differs", label: "Amount differs from finance (difference)" }] },
    { key: "not_on_statement", title: "In finance, missing from the bank statement", lines: [{ key: "in", label: "Money in" }, { key: "out", label: "Money out" }] },
    { key: "unmatched", title: "Bank lines matched to no record", lines: [{ key: "in", label: "Unmatched money in" }, { key: "out", label: "Unmatched money out" }] },
    { key: "flags", title: "Flags", lines: [{ key: "duplicate", label: "Marked duplicate" }, { key: "future", label: "Dated in the future" }, { key: "negative", label: "Accounts below zero" }, { key: "zero_opening", label: "Opening balance 0 (records)" }, { key: "never_reconciled", label: "Never reconciled (records)" }, { key: "drift", label: "Stored balance out of step" }], showTotal: false },
  ], (sum, currency) => {
    const mine = accounts.filter((a) => a.currency === currency && (a.lines || a.opening));
    const reconciled = mine.filter((a) => d.sessions.some((s) => String(s.accountId) === a.id && s.status === "completed")).length;
    return [
      { key: "system", label: `System-recorded total (${mine.length} accounts, ${reconciled} reconciled to a statement)`, amountMinor: sum("balances"), strong: true },
      { key: "verified", label: `Independently verified (reconciled to a statement): ${reconciled} account(s)`, amountMinor: rows.filter((r) => r.currency === currency && r.section === "balances" && r.status === "Reconciled").reduce((n, r) => n + r.amountMinor, 0) },
      { key: "differences", label: "Open reconciliation differences (latest sessions — unverified statement figures, not losses)", amountMinor: sum("differences") },
      { key: "unmatched_in", label: "Unmatched money in", amountMinor: sum("unmatched", "in") },
      { key: "unmatched_out", label: "Unmatched money out", amountMinor: sum("unmatched", "out") },
      { key: "duplicates", label: "Marked duplicate", amountMinor: sum("flags", "duplicate") },
    ];
  });
  return { rows, sides };
}

// ── 2. PSP ───────────────────────────────────────────────────────────────────

function pspOf(d: Data, base: string, from: string, to: string, asOf: string, today: string) {
  const rows: RCRow[] = [];
  const lo = Date.parse(`${from}T00:00:00Z`), hi = Date.parse(`${to}T23:59:59.999Z`), cut = Date.parse(`${asOf}T23:59:59.999Z`);
  const psps = d.bank.accounts.filter((a) => a.accountType === "psp");
  for (const a of psps) {
    const psp = (a as unknown as { psp?: { provider?: string; feeVatPct?: number; settlementDays?: number } }).psp ?? {};
    const name = psp.provider || a.accountName;
    const currency = cur(a.currency, base);
    const mine = d.bank.lines.filter((l) => String(l.accountId) === String(a._id));
    for (const l of mine) {
      const t = new Date(l.date).getTime();
      const isTransfer = !!(l.transfer && (l.transfer as { id?: unknown }).id);
      if (l.amountMinor > 0 && !isTransfer && t >= lo && t <= hi) rows.push(row(currency, { id: `col:${l._id}`, date: day(l.date), section: "collected", line: String(a._id), amountMinor: l.amountMinor, title: l.description ?? "", number: (l.matches ?? [])[0]?.referenceNumber ?? "", account: name, category: "Customer collection", href: `/banking/${a._id}` }));
      if (l.amountMinor > 0 && !isTransfer && !l.settlement && t <= cut) {
        const age = Math.floor((cut - t) / DAY);
        const late = age > (psp.settlementDays ?? 7);
        const r = row(currency, { id: `pend:${l._id}`, date: day(l.date), section: "pending", line: String(a._id), amountMinor: l.amountMinor, title: l.description ?? "", account: name, category: late ? "Pending beyond the settlement cycle" : "Pending, within the cycle", detail: `${age} days waiting (cycle ${psp.settlementDays ?? 7} days)`, href: `/banking/${a._id}`, status: `${age} days` });
        rows.push(late ? flag(r, "PSP payment not settled within its cycle", "medium", "suspected", "PSP settlements", "Check the provider's settlement report and record the settlement.", today) : r);
      }
    }
    const sets = d.settlements.filter((s) => String(s.pspAccountId) === String(a._id));
    const seen = new Map<string, number>();
    for (const s of sets) {
      const t = new Date(s.date).getTime();
      const k = `${s.grossMinor}|${day(s.date)}`; seen.set(k, (seen.get(k) ?? 0) + 1);
      if (t < lo || t > hi) continue;
      const fee = Number(s.feeMinor) || 0;
      const vat = psp.feeVatPct ? Math.round(fee - fee / (1 + psp.feeVatPct / 100)) : 0;
      rows.push(row(currency, { id: `fee:${s._id}`, date: day(s.date), section: "fees", line: String(a._id), amountMinor: fee, title: s.number, account: name, category: "Charges", detail: vat ? `of which VAT ${(vat / 100).toFixed(2)} at ${psp.feeVatPct}%` : "no VAT rate on the account", href: `/psp-settlements` }));
      if (vat) rows.push(row(currency, { id: `vat:${s._id}`, date: day(s.date), section: "fee_vat", line: String(a._id), amountMinor: vat, title: s.number, account: name, category: "VAT on charges", href: `/psp-settlements` }));
      rows.push(row(currency, { id: `set:${s._id}`, date: day(s.date), section: "settled", line: String(a._id), amountMinor: Number(s.receivedMinor) || 0, title: s.number, account: name, category: `Settled to ${s.bankAccountName}`, href: `/psp-settlements` }));
      const covered = (s.lineIds ?? []).map((id: unknown) => d.lineById.get(String(id))).filter(Boolean) as { date: Date; amountMinor: number }[];
      const linesGross = covered.reduce((n, l) => n + l.amountMinor, 0);
      const oldest = covered.reduce((m, l) => Math.min(m, new Date(l.date).getTime()), Infinity);
      const delay = oldest < Infinity ? Math.round((t - oldest) / DAY) : null;
      if (delay !== null) {
        const r = row(currency, { id: `delay:${s._id}`, date: day(s.date), section: "delays", line: String(a._id), amountMinor: Number(s.grossMinor) || 0, title: s.number, account: name, category: delay > (psp.settlementDays ?? 7) ? "Settled later than its cycle" : "Settled within its cycle", detail: `${delay} days from the oldest payment (cycle ${psp.settlementDays ?? 7})`, status: `${delay} days`, href: `/psp-settlements` });
        rows.push(r);
      }
      const diffs: [string, number][] = [];
      if (linesGross !== (Number(s.grossMinor) || 0)) diffs.push(["Settlement gross ≠ the payments it covers", (Number(s.grossMinor) || 0) - linesGross]);
      if ((Number(s.grossMinor) || 0) - fee !== (Number(s.receivedMinor) || 0)) diffs.push(["Gross − charges ≠ received", (Number(s.grossMinor) || 0) - fee - (Number(s.receivedMinor) || 0)]);
      if (!s.transferId) diffs.push(["No transfer to the bank recorded", Number(s.receivedMinor) || 0]);
      for (const [what, amount] of diffs) rows.push(flag(row(currency, { id: `pdiff:${s._id}:${what}`, date: day(s.date), section: "differences", line: String(a._id), amountMinor: amount, title: s.number, account: name, category: what, href: `/psp-settlements` }), "PSP settlement difference", "high", "confirmed", "PSP settlements", "Open the settlement and check it against the provider's report.", today));
    }
    for (const s of sets) {
      if ((seen.get(`${s.grossMinor}|${day(s.date)}`) ?? 0) > 1) rows.push(flag(row(currency, { id: `pdup:${s._id}`, date: day(s.date), section: "duplicates", line: String(a._id), amountMinor: Number(s.grossMinor) || 0, title: s.number, account: name, category: "Same gross on the same day", href: `/psp-settlements` }), "Possible duplicate PSP settlement", "high", "suspected", "PSP settlements", "Check it is not the same settlement recorded twice.", today));
    }
  }
  const lines = psps.map((a) => ({ key: String(a._id), label: (a as unknown as { psp?: { provider?: string } }).psp?.provider || a.accountName }));
  const sides = sidesOf(rows, base, [
    { key: "collected", title: "Customer collections received into the gateway (period)", lines },
    { key: "fees", title: "Transaction charges (period)", lines },
    { key: "fee_vat", title: "VAT on charges (period, at the account's rate)", lines },
    { key: "settled", title: "Settled to the bank (period)", lines },
    { key: "pending", title: "Pending settlement (as of the date)", lines },
    { key: "delays", title: "Settlement delay (gross of each settlement; days in the status)", lines, showTotal: false },
    { key: "differences", title: "Settlement differences", lines },
    { key: "duplicates", title: "Possible duplicate settlements", lines },
  ], (sum) => [
    { key: "collected", label: "Collected through gateways", amountMinor: sum("collected"), strong: true },
    { key: "fees", label: "Charges", amountMinor: sum("fees") },
    { key: "expected_net", label: "Expected net settlement (collected − charges)", amountMinor: sum("collected") - sum("fees") },
    { key: "settled", label: "Actually settled to the bank", amountMinor: sum("settled") },
    { key: "pending", label: "Pending settlement", amountMinor: sum("pending"), strong: true },
    { key: "differences", label: "Settlement differences", amountMinor: sum("differences") },
  ]);
  return { rows, sides };
}

// ── 3. Invoices and collections ──────────────────────────────────────────────

function invoicesOf(d: Data, base: string, asOf: string, today: string) {
  const rows: RCRow[] = [];
  const cut = Date.parse(`${asOf}T23:59:59.999Z`);
  const creditBy = new Map<string, number>();
  for (const n of d.notes) {
    if (Array.isArray(n.applications) && n.applications.length) for (const a of n.applications) creditBy.set(String(a.invoiceId), (creditBy.get(String(a.invoiceId)) ?? 0) + (Number(a.amountMinor) || 0));
    else creditBy.set(String(n.invoiceId), (creditBy.get(String(n.invoiceId)) ?? 0) + (Number(n.amountAppliedMinor) || 0));
  }
  const refCount = new Map<string, number>();
  for (const i of d.invoices) for (const p of i.payments ?? []) { const r = String(p.reference ?? "").trim().toLowerCase(); if (r) refCount.set(r, (refCount.get(r) ?? 0) + 1); }
  const pointed = new Set<string>();
  for (const i of d.invoices) {
    if (new Date(i.issueDate).getTime() > cut) continue;
    const currency = cur(i.currency, base);
    const old = isOld(i.external?.source);
    const base_ = { title: i.customerName ?? "", number: i.invoiceNumber, href: `/invoices/${i._id}` };
    const paid = (i.payments ?? []).reduce((n: number, p: any) => n + (Number(p.amountMinor) || 0), 0);
    for (const p of i.payments ?? []) {
      if (p.bankTransactionId) pointed.add(String(p.bankTransactionId));
      if (old || new Date(p.paidOn).getTime() > cut) continue;
      const pr = (section: string, line: string, extra: Partial<RCRow> = {}) => row(currency, { id: `pay:${i._id}:${p._id}`, date: day(p.paidOn), section, line, amountMinor: Number(p.amountMinor) || 0, ...base_, number: p.receiptNumber || p.reference || i.invoiceNumber, detail: `Payment towards ${i.invoiceNumber}`, ...extra });
      if (p.bankTransactionId && !d.lineById.has(String(p.bankTransactionId))) rows.push(flag(pr("payments", "missing_line", { category: "Points to a bank line that no longer exists" }), "Payment linked to a missing bank line", "high", "confirmed", "Invoices", "Re-link the payment to its bank line (it may have been deleted).", today));
      else if (!p.bankTransactionId) rows.push(flag(pr("payments", p.bankAccountId ? "no_line" : "no_bank", { category: p.bankAccountId ? "Account chosen, no bank line" : "No bank or PSP record" }), "Customer payment without a bank or PSP record", "medium", "missing", "Invoices", "Record or match the payment's bank or gateway line.", today));
      const r = String(p.reference ?? "").trim().toLowerCase();
      const n = r ? refCount.get(r) ?? 0 : 0;
      if (n > 1 && n <= 20) rows.push(flag(pr("references", "duplicate", { id: `ref:${i._id}:${p._id}`, category: `Reference used ${n} times`, detail: `reference "${p.reference}"` }), "Duplicate payment reference", "high", "suspected", "Invoices", "Check whether the same payment was recorded twice.", today));
      if (p.bankCurrency && String(p.bankCurrency).toUpperCase() !== currency && !p.original) rows.push(flag(pr("currency", "mismatch", { id: `cur:${i._id}:${p._id}`, category: `Paid into a ${p.bankCurrency} account, amount in that currency not recorded` }), "Currency mismatch on a payment", "medium", "missing", "Invoices", "Record what was paid in the account's currency.", today));
    }
    const total = Number(i.totalMinor) || 0, settled = Number(i.amountPaidMinor) || 0;
    if (i.status !== "void" && settled > total) rows.push(flag(row(currency, { id: `over:${i._id}`, date: day(i.issueDate), section: "integrity", line: "overpaid", amountMinor: settled - total, ...base_, category: "Overpaid" }), "Overpaid invoice", "critical", "confirmed", "Invoices", "Find the extra payment and move or refund it.", today));
    if (i.status !== "void" && (Number(i.balanceMinor) || 0) !== total - settled) rows.push(flag(row(currency, { id: `bal:${i._id}`, date: day(i.issueDate), section: "integrity", line: "balance", amountMinor: (Number(i.balanceMinor) || 0) - (total - settled), ...base_, category: "Balance ≠ total − settled" }), "Incorrect outstanding balance", "critical", "confirmed", "Invoices", "Re-save the invoice's payments so its balance is worked out again.", today));
    if (i.status === "void" && paid) rows.push(flag(row(currency, { id: `void:${i._id}`, date: day(i.issueDate), section: "integrity", line: "void_paid", amountMinor: paid, ...base_, category: "Void invoice still holds payments" }), "Voided invoice with retained payments", "high", "confirmed", "Invoices", "Decide whether the payments move to another invoice or are refunded.", today));
    const credit = settled - paid;
    const recorded = creditBy.get(String(i._id)) ?? 0;
    if (i.status !== "void" && credit !== recorded && !old) rows.push(flag(row(currency, { id: `cr:${i._id}`, date: day(i.issueDate), section: "integrity", line: "credit", amountMinor: credit - recorded, ...base_, category: "Settled beyond payments ≠ credit notes applied", detail: `settled ${(settled / 100).toFixed(2)}, payments ${(paid / 100).toFixed(2)}, credit applied ${(recorded / 100).toFixed(2)}` }), "Missing or inconsistent credit adjustment", "high", "confirmed", "Invoices", "Check the invoice's credit notes and payments.", today));
  }
  for (const l of d.bank.lines) {
    if (new Date(l.date).getTime() > cut) continue;
    const m = (l.matches ?? [])[0];
    if (m?.type !== "invoice" || pointed.has(String(l._id))) continue;
    const acc = d.bank.accById.get(String(l.accountId));
    rows.push(flag(row(cur(acc?.currency, base), { id: `bl:${l._id}`, date: day(l.date), section: "bank_side", line: "unpointed", amountMinor: l.amountMinor, title: l.description ?? "", number: m.referenceNumber, account: acc?.accountName ?? "", category: "Bank line matched to an invoice no payment points to", href: `/banking/${l.accountId}` }), "Bank receipt without a corresponding customer payment", "medium", "suspected", "Banking", "Record the payment on the invoice, or unmatch the line.", today));
  }
  const sides = sidesOf(rows, base, [
    { key: "payments", title: "Customer payments without a matching bank or PSP line (live)", lines: [{ key: "missing_line", label: "Linked to a bank line that no longer exists" }, { key: "no_line", label: "Bank account chosen, no line" }, { key: "no_bank", label: "No bank or PSP record" }] },
    { key: "bank_side", title: "Bank receipts without a corresponding customer payment", lines: [{ key: "unpointed", label: "Matched to an invoice, no payment points back" }] },
    { key: "references", title: "Duplicate payment references (live)", lines: [{ key: "duplicate", label: "Reference used more than once" }] },
    { key: "integrity", title: "Invoice integrity", lines: [{ key: "overpaid", label: "Overpaid" }, { key: "balance", label: "Balance ≠ total − settled" }, { key: "void_paid", label: "Void invoices with payments" }, { key: "credit", label: "Credit adjustments inconsistent" }] },
    { key: "currency", title: "Currency mismatches", lines: [{ key: "mismatch", label: "Paid into another currency's account, amount there not recorded" }] },
  ], (sum) => [
    { key: "no_bank", label: "Payments without a bank or PSP line", amountMinor: sum("payments"), strong: true },
    { key: "bank_side", label: "Bank receipts without a payment", amountMinor: sum("bank_side") },
    { key: "integrity", label: "Integrity failures (overpaid, balance, void, credit)", amountMinor: sum("integrity") },
  ]);
  return { rows, sides };
}

// ── 4. Expenses and suppliers ────────────────────────────────────────────────

const BALANCE_SHEET_LIKE = ["employee_advances", "vat_control", "payroll_payable"];
function expensesOf(d: Data, base: string, from: string, to: string, asOf: string, today: string) {
  const rows: RCRow[] = [];
  const lo = Date.parse(`${from}T00:00:00Z`), hi = Date.parse(`${to}T23:59:59.999Z`), cut = Date.parse(`${asOf}T23:59:59.999Z`);
  const mirrors = new Map(d.expenses.filter((e) => e.source?.kind === "bill").map((e) => [String(e.source?.key), e]));
  for (const b of d.bills) {
    if (b.status === "voided" || new Date(b.billDate).getTime() > cut) continue;
    const currency = cur(b.currency, base);
    const m = mirrors.get(`bill:${b._id}`);
    const common = { title: b.vendorName ?? "", number: b.billNumber, href: `/bills/${b._id}` };
    if (!m) rows.push(flag(row(currency, { id: `mir:${b._id}`, date: day(b.billDate), section: "bills", line: "no_mirror", amountMinor: Number(b.totalMinor) || 0, ...common, category: "Bill without its expense" }), "Supplier bill without its mirror expense", "medium", "confirmed", "Bills", "Open and save the bill so its expense is made.", today));
    else if ((Number(m.totalMinor) || 0) !== (Number(b.totalMinor) || 0)) rows.push(flag(row(currency, { id: `mir:${b._id}`, date: day(b.billDate), section: "bills", line: "mirror_differs", amountMinor: (Number(m.totalMinor) || 0) - (Number(b.totalMinor) || 0), ...common, category: "Mirror expense amount differs" }), "Bill and mirror expense differ", "medium", "confirmed", "Bills", "Open and save the bill so its expense follows it.", today));
    for (const p of b.payments ?? []) {
      if (new Date(p.paidOn).getTime() > cut) continue;
      if (!p.bankTransactionId || !d.lineById.has(String(p.bankTransactionId))) rows.push(flag(row(currency, { id: `bp:${b._id}:${p._id}`, date: day(p.paidOn), section: "bills", line: "payment_no_line", amountMinor: Number(p.amountMinor) || 0, ...common, category: p.bankTransactionId ? "Payment's bank line no longer exists" : "Supplier payment without a bank line" }), "Supplier payment without a bank transaction", p.bankTransactionId ? "high" : "medium", p.bankTransactionId ? "confirmed" : "missing", "Bills", "Record or match the payment's bank line.", today));
    }
  }
  for (const v of d.vendorCredits) {
    if (new Date(v.issueDate).getTime() > cut) continue;
    const left = (Number(v.totalMinor) || 0) - (Number(v.amountAppliedMinor) || 0);
    if (left > 0) rows.push(flag(row(cur(v.currency, base), { id: `vc:${v._id}`, date: day(v.issueDate), section: "vendor_credits", line: "unapplied", amountMinor: left, title: v.vendorName ?? "", number: v.creditNumber, category: "Vendor credit not yet used", href: `/vendor-credits/${v._id}` }), "Vendor credit not applied", "low", "missing", "Vendor credits", "Apply it to the supplier's next bill.", today));
  }
  const groups = new Map<string, any[]>();
  for (const e of d.expenses) {
    const kind = e.source?.kind;
    const t = new Date(e.expenseDate).getTime();
    if (t > cut || kind === "import" || kind === "bill" || kind === "payroll") continue;
    const k = `${day(e.expenseDate)}|${e.totalMinor}|${e.category}|${cur(e.currency, base)}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    for (const e of list.slice(1)) rows.push(flag(row(cur(e.currency, base), { id: `ed:${e._id}`, date: day(e.expenseDate), section: "duplicates", line: "possible", amountMinor: Number(e.totalMinor) || 0, title: e.description ?? "", number: e.expenseNumber ?? "", category: `Same date, amount and category as ${list[0].expenseNumber}`, href: `/expenses/${e._id}` }), "Possible duplicate expense", "high", "suspected", "Expenses", `Compare with ${list[0].expenseNumber}; void one if it was entered twice.`, today));
  }
  for (const e of d.expenses) {
    const kind = e.source?.kind;
    if (kind === "import" || kind === "bill" || kind === "payroll" || new Date(e.expenseDate).getTime() > cut) continue;
    const currency = cur(e.currency, base);
    const common = { title: e.description ?? "", number: e.expenseNumber ?? "", href: `/expenses/${e._id}` };
    if (e.status === "approved" && e.paidOn && !e.bankTransactionId && e.paymentMethod !== "cash") rows.push(flag(row(currency, { id: `enb:${e._id}`, date: day(e.paidOn), section: "no_bank", line: "paid_no_line", amountMinor: Number(e.totalMinor) || 0, ...common, category: e.categoryName || e.category }), "Paid expense without a bank transaction", "medium", "missing", "Expenses", "Record or match its bank line.", today));
    if (e.status === "approved" && e.paidOn && e.paymentMethod && e.paymentMethod !== "cash" && !String(e.reference ?? "").trim()) rows.push(flag(row(currency, { id: `eref:${e._id}`, date: day(e.paidOn), section: "references", line: "missing", amountMinor: Number(e.totalMinor) || 0, ...common, category: e.categoryName || e.category }), "Missing payment reference", "low", "missing", "Expenses", "Add the payment reference.", today));
    const t = new Date(e.expenseDate).getTime();
    if (t >= lo && t <= hi && (Number(e.taxMinor) || 0) > 0) rows.push(row(currency, { id: `evat:${e._id}`, date: day(e.expenseDate), section: "vat", line: "expense_vat", amountMinor: Number(e.taxMinor) || 0, ...common, category: "VAT on an expense (counted as cost, not input VAT)" }));
    if (t >= lo && t <= hi && BALANCE_SHEET_LIKE.includes(e.category)) rows.push(flag(row(currency, { id: `bsl:${e._id}`, date: day(e.expenseDate), section: "classification", line: e.category, amountMinor: Number(e.totalMinor) || 0, ...common, category: e.categoryName || e.category }), "Balance-sheet-like category counted in the P&L", "low", "suspected", "Expense categories", "Accounts to confirm whether it is an operating cost; the category setting decides.", today));
  }
  const sides = sidesOf(rows, base, [
    { key: "bills", title: "Supplier bills", lines: [{ key: "no_mirror", label: "Bill without its mirror expense" }, { key: "mirror_differs", label: "Mirror expense differs" }, { key: "payment_no_line", label: "Supplier payment without a bank line" }] },
    { key: "vendor_credits", title: "Vendor credits", lines: [{ key: "unapplied", label: "Issued, not yet used" }] },
    { key: "duplicates", title: "Possible duplicate expenses (same organization, date, amount and category)", lines: [{ key: "possible", label: "The second and later of each group" }] },
    { key: "no_bank", title: "Paid expenses without a bank transaction (not cash)", lines: [{ key: "paid_no_line", label: "Paid, no bank line" }] },
    { key: "references", title: "Missing payment references (paid, not cash)", lines: [{ key: "missing", label: "No reference" }] },
    { key: "vat", title: "VAT on expenses in the period (cost, not input VAT — recoverability not recorded)", lines: [{ key: "expense_vat", label: "VAT recorded on expenses" }] },
    { key: "classification", title: "Balance-sheet-like categories counted in the P&L (period)", lines: [{ key: "employee_advances", label: "Employee Advances Receivable" }, { key: "vat_control", label: "VAT Control Account" }, { key: "payroll_payable", label: "Payroll Payable / Payroll Clearing" }] },
  ], (sum) => [
    { key: "classification", label: "Balance-sheet-like categories in the P&L (period)", amountMinor: sum("classification"), strong: true },
    { key: "duplicates", label: "Possible duplicate expenses", amountMinor: sum("duplicates") },
    { key: "no_bank", label: "Paid without a bank transaction", amountMinor: sum("no_bank") },
  ]);
  return { rows, sides };
}

// ── 5. Payroll and commission ────────────────────────────────────────────────

function payrollOf(d: Data, base: string, from: string, to: string, asOf: string, today: string) {
  const rows: RCRow[] = [];
  const lo = Date.parse(`${from}T00:00:00Z`), hi = Date.parse(`${to}T23:59:59.999Z`), cut = Date.parse(`${asOf}T23:59:59.999Z`);
  const live = ["approved", "partially_paid", "paid"];
  const onRuns = { crm: new Set<string>(), cs: new Set<string>(), records: new Set<string>() };
  for (const r of d.runs) if (live.includes(r.status)) for (const a of r.adjustments ?? []) {
    for (const id of a.crmPayoutIds ?? []) onRuns.crm.add(String(id));
    for (const id of a.csPayoutIds ?? []) onRuns.cs.add(String(id));
    for (const id of a.commissionRecordIds ?? []) onRuns.records.add(String(id));
  }
  for (const r of d.runs) {
    if (!live.includes(r.status)) continue;
    const end = payrollMonthEnd(r.period).getTime();
    const currencyOf = (c: unknown) => cur(c || r.currency, base);
    if (end >= lo && end <= hi) {
      const by = new Map<string, { payable: number; paid: number; held: number; n: number }>();
      for (const l of r.lines ?? []) { const c = currencyOf(l.currency); const t = by.get(c) ?? { payable: 0, paid: 0, held: 0, n: 0 }; t.payable += Number(l.payableMinor) || 0; t.paid += Math.min(Number(l.payableMinor) || 0, Number(l.amountPaidMinor) || 0); if (l.status === "on_hold") t.held++; t.n++; by.set(c, t); }
      for (const [c, t] of by) {
        rows.push(row(c, { id: `obl:${r._id}:${c}`, date: day(payrollMonthEnd(r.period)), section: "obligation", line: "payable", amountMinor: t.payable, title: r.runNumber, number: r.runNumber, category: `Payroll ${r.period}`, detail: `${t.n} people, ${t.held} on hold`, href: `/payroll/${r._id}`, status: r.status }));
        rows.push(row(c, { id: `opd:${r._id}:${c}`, date: day(payrollMonthEnd(r.period)), section: "obligation", line: "outstanding", amountMinor: t.payable - t.paid, title: r.runNumber, number: r.runNumber, category: `Outstanding ${r.period}`, href: `/payroll/${r._id}`, status: r.status }));
        // A run left with nothing paid long after its month, most people on hold: likely a test or a stale import.
        if (t.paid === 0 && t.payable > 0 && (Date.parse(today) - end) / DAY > 45) rows.push(flag(row(c, { id: `stale:${r._id}:${c}`, date: day(payrollMonthEnd(r.period)), section: "exceptions", line: "stale_run", amountMinor: t.payable, title: r.runNumber, number: r.runNumber, category: `Nothing paid ${Math.floor((Date.parse(today) - end) / DAY)} days after the month; ${t.held} of ${t.n} on hold`, href: `/payroll/${r._id}` }), "Payroll run approved but never paid", "high", "suspected", "Payroll", "Confirm the run is real; if not, return it in finance.", today));
      }
    }
    for (const p of r.payments ?? []) {
      const t = new Date(p.paidOn).getTime();
      if (t < lo || t > hi) continue;
      const c = currencyOf(p.currency);
      if (p.reversedAt) rows.push(row(c, { id: `rev:${r._id}:${p.paymentId}`, date: day(p.reversedAt), section: "payments", line: "reversed", amountMinor: -(Number(p.amountMinor) || 0), title: r.runNumber, number: p.paymentId, category: "Reversed payment", href: `/payroll/${r._id}` }));
      rows.push(row(c, { id: `pp:${r._id}:${p.paymentId}`, date: day(p.paidOn), section: "payments", line: "paid", amountMinor: Number(p.amountMinor) || 0, title: r.runNumber, number: p.paymentId, category: "Payroll payment", href: `/payroll/${r._id}` }));
      if (!p.reversedAt && p.bankTransactionId && !d.lineById.has(String(p.bankTransactionId))) rows.push(flag(row(c, { id: `ppl:${r._id}:${p.paymentId}`, date: day(p.paidOn), section: "exceptions", line: "payment_no_line", amountMinor: Number(p.amountMinor) || 0, title: r.runNumber, number: p.paymentId, category: "Payment's bank line no longer exists", href: `/payroll/${r._id}` }), "Payroll payment without its bank transaction", "high", "confirmed", "Payroll", "Check the bank line was not deleted; re-link or re-pay.", today));
    }
    for (const l of r.lines ?? []) for (const dd of l.deductions ?? []) {
      if (!/advance|loan/i.test(String(dd.label ?? "")) || end < lo || end > hi) continue;
      rows.push(row(currencyOf(l.currency), { id: `ded:${r._id}:${l._id}:${dd.label}`, date: day(payrollMonthEnd(r.period)), section: "deductions", line: /salary advance/i.test(dd.label) ? "salary_advance" : "other_loan", amountMinor: Number(dd.amountMinor) || 0, title: l.name ?? "", number: r.runNumber, category: dd.label, href: `/payroll/${r._id}` }));
    }
  }
  const payoutRows: { which: "crm" | "cs"; p: any; month: string }[] = [...d.crm.map((p) => ({ which: "crm" as const, p, month: String(p.month ?? "") })), ...d.cs.map((p) => ({ which: "cs" as const, p, month: String(p.lastMonth ?? "") }))];
  for (const { which, p, month } of payoutRows) {
    if (!/^\d{4}-\d{2}$/.test(month)) continue;
    const end = payrollMonthEnd(month).getTime();
    if (end < lo || end > hi) continue;
    const c = cur(p.currency, base);
    const inRun = !!p.payrollRunId || onRuns[which].has(String(p._id));
    const line = inRun ? "in_payroll" : p.state === "paid" ? (p.expenseId ? "paid_direct" : "paid_other") : "approved_unpaid";
    rows.push(row(c, { id: `po:${which}:${p._id}`, date: day(payrollMonthEnd(month)), section: "commission", line, amountMinor: Number(p.amountMinor) || 0, title: p.personName ?? "", category: `${which === "crm" ? "CRM" : "CS"} commission ${month}`, href: which === "crm" ? "/commissions/crm" : "/commissions/cs", status: p.state }));
  }
  for (const c of d.records) {
    const t = new Date(c.calculatedAt).getTime();
    if (t < lo || t > hi) continue;
    const inRun = !!c.payrollRunId || onRuns.records.has(String(c._id));
    rows.push(row(base, { id: `rec:${c._id}`, date: day(c.calculatedAt), section: "commission", line: inRun ? "in_payroll" : c.status === "paid" ? "paid_direct" : c.status === "cancelled" ? "cancelled" : "earned_unpaid", amountMinor: Number(c.commissionMinor) || 0, title: c.salespersonName ?? "", number: c.invoiceNumber ?? "", category: "Finance commission record", href: "/commissions", status: c.status }));
  }
  // Possible overlap: commission typed as an expense in a month (and currency) for which payouts exist — finance cannot
  // tell whether it pays the same commission. Stronger when the payout's person is named in the expense.
  const linked = new Set([...d.crm, ...d.cs].filter((p) => p.expenseId).map((p) => String(p.expenseId)).concat(d.records.filter((r) => r.paidExpenseId).map((r) => String(r.paidExpenseId))));
  for (const e of d.expenses) {
    if (e.category !== "sales_commission" || linked.has(String(e._id))) continue;
    const t = new Date(e.expenseDate).getTime();
    if (t < lo || t > hi) continue;
    const month = day(e.expenseDate).slice(0, 7);
    const c = cur(e.currency, base);
    const same = payoutRows.filter(({ p, month: m }) => m === month && cur(p.currency, base) === c);
    const named = same.find(({ p }) => p.personName && String(e.description ?? "").toLowerCase().includes(String(p.personName).toLowerCase().split(" ")[0]!));
    const r = row(c, { id: `ov:${e._id}`, date: day(e.expenseDate), section: "overlap", line: named ? "named" : same.length ? "same_month" : "no_payouts", amountMinor: Number(e.totalMinor) || 0, title: e.description ?? "", number: e.expenseNumber ?? "", category: named ? `Names ${named.p.personName}, who has a payout this month` : same.length ? `${same.length} payout(s) in the same month` : "No payout in the same month", href: `/expenses/${e._id}` });
    rows.push(named ? flag(r, "Possible overlap: typed commission expense and a payout", "high", "suspected", "Commission", "Check whether this expense pays the same commission as the payout.", today) : same.length ? flag(r, "Typed commission expense beside payouts", "medium", "suspected", "Commission", "Confirm it is not the same commission as a payout or payroll addition.", today) : r);
  }
  const sides = sidesOf(rows, base, [
    { key: "obligation", title: "Payroll obligation (runs of the period)", lines: [{ key: "payable", label: "Payroll obligation (payable)" }, { key: "outstanding", label: "Outstanding salary" }], showTotal: false },
    { key: "payments", title: "Payroll payments in the period", lines: [{ key: "paid", label: "Payments made" }, { key: "reversed", label: "Reversed" }] },
    { key: "deductions", title: "Advance and loan deductions on payslips", lines: [{ key: "salary_advance", label: "Salary advance deductions" }, { key: "other_loan", label: "Other loan deductions (visa loans etc.)" }] },
    { key: "commission", title: "Commission of the period by state", lines: [{ key: "earned_unpaid", label: "Earned in finance, not paid" }, { key: "approved_unpaid", label: "Approved, not paid" }, { key: "paid_direct", label: "Paid directly" }, { key: "paid_other", label: "Paid (no expense linked)" }, { key: "in_payroll", label: "Included in payroll" }, { key: "cancelled", label: "Cancelled" }] },
    { key: "overlap", title: "Commission typed as an expense (not a payout's payment)", lines: [{ key: "named", label: "Names a person with a payout that month" }, { key: "same_month", label: "Payouts exist in the same month" }, { key: "no_payouts", label: "No payout that month" }] },
    { key: "exceptions", title: "Payroll exceptions", lines: [{ key: "stale_run", label: "Runs approved but never paid" }, { key: "payment_no_line", label: "Payments whose bank line is gone" }] },
  ], (sum) => [
    { key: "obligation", label: "Payroll obligation", amountMinor: sum("obligation", "payable"), strong: true },
    { key: "paid", label: "Paid in the period (less reversals)", amountMinor: sum("payments") },
    { key: "outstanding", label: "Outstanding salary (runs of the period)", amountMinor: sum("obligation", "outstanding") },
    { key: "commission_outstanding", label: "Commission outstanding (earned or approved, not paid, not in payroll)", amountMinor: sum("commission", "earned_unpaid") + sum("commission", "approved_unpaid") },
    { key: "overlap", label: "Typed commission beside payouts (possible overlap)", amountMinor: sum("overlap", "named") + sum("overlap", "same_month") },
  ]);
  return { rows, sides };
}

// ── 6. Advances ──────────────────────────────────────────────────────────────

async function advancesRc(orgId: string, base: string, asOf: string, today: string, warnings: string[]) {
  const a = await advancesOf(orgId, base, asOf, warnings);
  const rows: RCRow[] = (a.rows as RCRow[]).map((r) => {
    if (r.section === "earlier") return flag(r, "Recovery exceeds the advances recorded in finance", "medium", "missing", "Advances", "Find the earlier advance this repays (old books or HRMS).", today);
    if (r.section === "other_loans") return { ...r };
    return r;
  });
  // The old-books / typed advances: one exception per currency, not 600 — recoveries are simply not recorded.
  for (const s of a.sides) {
    const unknown = s.totals.find((t) => t.key === "unknown")?.amountMinor ?? 0;
    if (unknown) rows.push(flag(row(s.currency, { id: `advunk:${s.currency}`, date: asOf, section: "summary_flags", line: "unknown", amountMinor: unknown, title: "Advances with no recovery records", category: "Old books and typed advances", href: "/advances" }), "Historical advances without recovery information", "medium", "missing", "Advances", "Needs HRMS's recovery figures (an HRMS change, for approval) or Accounts' records.", today));
  }
  return { rows, sides: a.sides };
}

// ── 7. Historical data ───────────────────────────────────────────────────────

function historicalOf(d: Data, base: string, asOf: string, today: string) {
  const rows: RCRow[] = [];
  const cut = Date.parse(`${asOf}T23:59:59.999Z`), cutover = Date.parse(`${CUTOVER}T00:00:00Z`);
  for (const i of d.invoices) {
    if (!isOld(i.external?.source) || new Date(i.issueDate).getTime() > cut) continue;
    const c = cur(i.currency, base);
    rows.push(row(c, { id: `obi:${i._id}`, date: day(i.issueDate), section: "old_books", line: "invoices", amountMinor: Number(i.totalMinor) || 0, title: i.customerName ?? "", number: i.invoiceNumber, category: "Old-books invoice", href: `/invoices/${i._id}`, status: "Migrated" }));
    if ((Number(i.balanceMinor) || 0) > 0 && i.status !== "void") rows.push(row(c, { id: `obr:${i._id}`, date: day(i.issueDate), section: "old_books", line: "receivables", amountMinor: Number(i.balanceMinor) || 0, title: i.customerName ?? "", number: i.invoiceNumber, category: "Old-books receivable", href: `/invoices/${i._id}`, status: "Unverified" }));
    for (const p of i.payments ?? []) rows.push(row(c, { id: `obp:${i._id}:${p._id}`, date: day(p.paidOn), section: "old_books", line: "payments", amountMinor: Number(p.amountMinor) || 0, title: i.customerName ?? "", number: p.reference || i.invoiceNumber, category: "Migrated customer payment", detail: p.bankTransactionId ? "has a bank line" : "no bank record — expected for migrated data", href: `/invoices/${i._id}`, status: p.bankTransactionId ? "Linked" : "Migrated, no bank record expected" }));
  }
  const liveKey = new Set(d.expenses.filter((e) => e.source?.kind !== "import").map((e) => `${day(e.expenseDate)}|${e.totalMinor}|${cur(e.currency, base)}`));
  for (const e of d.expenses) {
    if (e.source?.kind !== "import" || new Date(e.expenseDate).getTime() > cut) continue;
    const c = cur(e.currency, base);
    const adv = e.category === "employee_advances";
    const r = row(c, { id: `obe:${e._id}`, date: day(e.expenseDate), section: "old_books", line: adv ? "advances" : "expenses", amountMinor: Number(e.totalMinor) || 0, title: e.description ?? "", number: e.expenseNumber ?? "", category: adv ? "Historical employee advance" : "Migrated expense", href: `/expenses/${e._id}`, status: "Migrated, no bank record expected" });
    rows.push(r);
    // An import dated after live records began, with a live expense of the same day, amount and currency: maybe twice.
    const overlap = liveKey.has(`${day(e.expenseDate)}|${e.totalMinor}|${c}`);
    if (new Date(e.expenseDate).getTime() >= cutover || overlap) rows.push(flag({ ...r, id: `obo:${e._id}`, section: "discrepancies", line: overlap ? "overlap" : "after_cutover", category: overlap ? "A live expense has the same day, amount and currency" : "Import dated on or after the cutover", status: "Unverified", detail: `recorded ${((Number(e.totalMinor) || 0) / 100).toFixed(2)}, verified —, difference —` }, "Migrated record may duplicate a live one", overlap ? "high" : "medium", "suspected", "Old books", "Compare with the live record; void one if both are the same.", today));
  }
  for (const a of accountsAt(d.bank, asOf)) {
    if (!a.lines && !a.opening) continue;
    const verified = d.sessions.some((s) => String(s.accountId) === a.id && s.status === "completed" && s.periodFrom && day(s.periodFrom) <= a.openingDate);
    rows.push(row(a.currency, { id: `ob:${a.id}`, date: a.openingDate, section: "opening", line: verified ? "verified" : "unverified", amountMinor: a.opening, title: a.name, account: a.name, category: verified ? "Opening balance verified by a reconciliation" : "Opening balance not verified", href: `/banking/${a.id}`, status: verified ? "Verified" : "Unverified", detail: `opening ${(a.opening / 100).toFixed(2)} on ${a.openingDate}` }));
  }
  const liveInv = d.invoices.filter((i) => !isOld(i.external?.source) && new Date(i.issueDate).getTime() <= cut);
  for (const i of liveInv) rows.push(row(cur(i.currency, base), { id: `lvi:${i._id}`, date: day(i.issueDate), section: "live", line: new Date(i.issueDate).getTime() >= cutover ? "after_cutover" : "before_cutover", amountMinor: Number(i.totalMinor) || 0, title: i.customerName ?? "", number: i.invoiceNumber, category: "Live invoice", href: `/invoices/${i._id}`, status: "Live" }));
  const sides = sidesOf(rows, base, [
    { key: "old_books", title: "Old books (migrated)", lines: [{ key: "invoices", label: "Old-books invoices" }, { key: "receivables", label: "Old-books receivables outstanding" }, { key: "payments", label: "Migrated customer payments" }, { key: "expenses", label: "Migrated expenses" }, { key: "advances", label: "Historical employee advances" }] },
    { key: "opening", title: "Opening bank balances", lines: [{ key: "verified", label: "Verified by a completed reconciliation" }, { key: "unverified", label: "Not verified" }] },
    { key: "live", title: `Live invoices (cutover proposed: ${CUTOVER})`, lines: [{ key: "before_cutover", label: "Before the cutover" }, { key: "after_cutover", label: "On or after the cutover" }] },
    { key: "discrepancies", title: "Historical discrepancies", lines: [{ key: "overlap", label: "Import with a matching live record (possible double count)" }, { key: "after_cutover", label: "Import dated on or after the cutover" }] },
  ], (sum) => [
    { key: "old_receivables", label: "Old-books receivables outstanding (unverified)", amountMinor: sum("old_books", "receivables"), strong: true },
    { key: "discrepancies", label: "Historical discrepancies (possible double count)", amountMinor: sum("discrepancies") },
    { key: "unverified_opening", label: "Opening balances not verified", amountMinor: sum("opening", "unverified") },
  ]);
  return { rows, sides };
}

// ── 8. Exceptions and the summary ────────────────────────────────────────────

const RC_NOTES: Record<RCReport, string[]> = {
  bank: [
    "A correct running balance (opening + lines, as finance keeps it) is not a reconciled balance: only a completed reconciliation against a bank statement confirms one. Nothing here ticks lines or changes a balance.",
    "What the statement has and finance lacks (and the reverse) comes from each account's latest statement check in Banking; an account never checked has none.",
  ],
  psp: [
    "From finance's PSP settlements: collections are the payments received into the gateway account; a settlement moves what arrived to the bank by a transfer and books its charges, so nothing is counted twice.",
    "Provider statements are not held in finance: differences are against finance's own records. Refunds and chargebacks are not recorded in finance. Charges are as each settlement recorded them; no fee rate is kept, so an expected-fee difference cannot be worked out.",
  ],
  invoices: [
    "Live records only: old-books payments without a bank line are migrated data and are listed under Historical data, not here. Nothing is deleted, refunded, reallocated or adjusted.",
    "A reference used more than 20 times is treated as a placeholder, not a duplicate.",
  ],
  expenses: [
    "A possible duplicate is an expense with the same organization, date, amount and category as another (imports, bills and payroll left out) — suspected until checked.",
    "Balance-sheet-like categories follow production's category settings, which count them in the P&L; nothing is changed here. Expense VAT is recorded as cost; whether it is recoverable is not recorded in finance.",
  ],
  payroll: [
    "Phase 3 and 4 rules: payroll obligation = payable per person in approved runs; commission in a payroll run is in payroll, never twice. Typed commission expenses cannot be linked to a payout by finance, so overlap is suspected only.",
  ],
  advances: [
    "Phase 4's advances. Recoveries above what finance issued are repayments of earlier advances; old-books and typed advances have no recovery records — not estimated.",
    "HRMS already keeps each advance's amount repaid (its Loan record), but does not share it with finance. Minimum change proposed for approval: a read-only HRMS endpoint returning each loan or advance with its amount repaid.",
  ],
  historical: [
    `Cutover proposed for management approval: ${CUTOVER}. Before it, old books; from it, live records. Opening balances to be confirmed against bank statements as of the day before.`,
    "A migrated record without a bank line is not an error — migrated data never had one. Verified amounts appear only where a completed reconciliation exists. No balancing entry, write-off or change is made.",
  ],
  exceptions: [
    "Every item needing action, once each (the most serious if a record has several). Status is worked out each time from the records: confirmed discrepancy, suspected, missing information, or open reconciliation difference (a statement figure not yet verified — never a confirmed loss). Nothing is stored.",
    "Critical: an integrity rule broken. High: a material discrepancy to investigate. Medium: missing information or incomplete reconciliation. Low: classification or documentation.",
  ],
  summary: ["Live figures from finance's reconciliation reports. No sample data."],
};

/** One report (or all of them, for the exception list and the summary). */
export async function reconciliationReport(orgId: string, report: RCReport, from: string, to: string, opts: { withParts?: boolean } = {}) {
  const base = (await baseCurrencyOf(orgId)).toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const asOf = to > today ? today : to;
  const warnings: string[] = [];
  const d = await load(orgId);
  const build = async (r: Exclude<RCReport, "exceptions" | "summary">) => {
    switch (r) {
      case "bank": return bankOf(d, base, asOf, today);
      case "psp": return pspOf(d, base, from, to, asOf, today);
      case "invoices": return invoicesOf(d, base, asOf, today);
      case "expenses": return expensesOf(d, base, from, to, asOf, today);
      case "payroll": return payrollOf(d, base, from, to, asOf, today);
      case "advances": return advancesRc(orgId, base, asOf, today, warnings);
      case "historical": return historicalOf(d, base, asOf, today);
    }
  };
  if (report !== "exceptions" && report !== "summary") {
    const { rows, sides } = await build(report);
    return { report, currency: base, from, to, asOf, cutover: CUTOVER, sides, months: [], notes: RC_NOTES[report], warnings, recordCount: rows.length, rows, indicators: [] as Indicator[] };
  }
  const parts: Record<string, RCRow[]> = {};
  for (const r of ["bank", "psp", "invoices", "expenses", "payroll", "advances", "historical"] as const) parts[r] = (await build(r)).rows;
  // One exception per underlying record: the same bank line or invoice met by two checks keeps the most serious.
  const byKey = new Map<string, RCRow>();
  for (const r of Object.values(parts).flat()) {
    if (!r.severity) continue;
    const key = r.id.replace(/^(um|bl|dup|enb|eref|ed|ov|out|nos):/, "line:");
    const k = `${r.exception === "Missing payment reference" ? "ref" : "rec"}:${key}`;
    const had = byKey.get(k);
    if (!had || SEVERITY_RANK[r.severity] > SEVERITY_RANK[had.severity!]) byKey.set(k, r);
  }
  const exceptions = [...byKey.values()].map((r) => ({ ...r, section: r.severity!, line: r.exception!, category: r.exception!, status: CONFIDENCE_LABEL[r.confidence!], kind: SEVERITY_LABEL[r.severity!], band: r.module }));
  const types = [...new Set(exceptions.map((r) => r.exception!))].sort();
  const sides = sidesOf(exceptions, base, (["critical", "high", "medium", "low"] as const).map((s) => ({ key: s, title: `${SEVERITY_LABEL[s]}`, lines: types.map((t) => ({ key: t, label: t })) })), (sum, currency) => {
    const mine = exceptions.filter((r) => r.currency === currency);
    const n = (f: (r: RCRow) => boolean) => mine.filter(f).length;
    return [
      { key: "open", label: `Open exceptions: ${mine.length} (critical ${n((r) => r.severity === "critical")}, high ${n((r) => r.severity === "high")}, medium ${n((r) => r.severity === "medium")}, low ${n((r) => r.severity === "low")})`, amountMinor: mine.reduce((t, r) => t + Math.abs(r.amountMinor), 0), strong: true },
      { key: "confirmed", label: `Confirmed discrepancies: ${n((r) => r.confidence === "confirmed")}`, amountMinor: mine.filter((r) => r.confidence === "confirmed").reduce((t, r) => t + Math.abs(r.amountMinor), 0) },
      { key: "suspected", label: `Suspected: ${n((r) => r.confidence === "suspected")}`, amountMinor: mine.filter((r) => r.confidence === "suspected").reduce((t, r) => t + Math.abs(r.amountMinor), 0) },
      { key: "open_differences", label: `Open reconciliation differences: ${n((r) => r.confidence === "open")} (unverified statement figures — not losses)`, amountMinor: mine.filter((r) => r.confidence === "open").reduce((t, r) => t + Math.abs(r.amountMinor), 0) },
      { key: "missing", label: `Missing information: ${n((r) => r.confidence === "missing")}`, amountMinor: mine.filter((r) => r.confidence === "missing").reduce((t, r) => t + Math.abs(r.amountMinor), 0) },
    ];
  });
  if (report === "exceptions") return { report, currency: base, from, to, asOf, cutover: CUTOVER, sides, months: [], notes: RC_NOTES.exceptions, warnings, recordCount: exceptions.length, rows: exceptions, indicators: [] as Indicator[] };

  // Summary: the dashboard's indicators, per currency, each from the reports above.
  const currencies = [...new Set([base, ...Object.values(parts).flat().map((r) => r.currency)])];
  const indicators: Indicator[] = [];
  for (const c of currencies) {
    const pick = (rs: RCRow[], f: (r: RCRow) => boolean) => rs.filter((r) => r.currency === c && f(r));
    const sumOf = (rs: RCRow[]) => rs.reduce((t, r) => t + r.amountMinor, 0);
    const accts = pick(parts.bank!, (r) => r.section === "balances");
    const reconciled = accts.filter((r) => r.status === "Reconciled").length;
    const ex = exceptions.filter((r) => r.currency === c);
    const add = (key: string, label: string, value: number, as: Indicator["as"], report: string, line = "all") => indicators.push({ currency: c, key, label, value, as, report, line });
    add("accounts", "Bank accounts", accts.length, "count", "bank", "balances");
    add("reconciled", "Reconciled to a statement", reconciled, "count", "bank", "balances");
    add("unreconciled", "Not reconciled", accts.length - reconciled, "count", "bank", "balances");
    add("differences", "Reconciliation differences", sumOf(pick(parts.bank!, (r) => r.section === "differences")), "money", "bank", "differences");
    add("unmatched_in", "Unmatched bank inflows", sumOf(pick(parts.bank!, (r) => r.section === "unmatched" && r.line === "in")), "money", "bank", "unmatched:in");
    add("unmatched_out", "Unmatched bank outflows", sumOf(pick(parts.bank!, (r) => r.section === "unmatched" && r.line === "out")), "money", "bank", "unmatched:out");
    add("psp_pending", "Pending PSP settlements", sumOf(pick(parts.psp!, (r) => r.section === "pending")), "money", "psp", "pending");
    add("psp_differences", "PSP settlement differences", sumOf(pick(parts.psp!, (r) => r.section === "differences")), "money", "psp", "differences");
    add("invoice_issues", "Invoice and collection discrepancies", pick(parts.invoices!, (r) => !!r.severity).length, "count", "invoices");
    add("historical", "Historical migration discrepancies", pick(parts.historical!, (r) => r.section === "discrepancies").length, "count", "historical", "discrepancies");
    add("duplicates", "Potential duplicate transactions", ex.filter((r) => /duplicate/i.test(r.exception ?? "")).length, "count", "exceptions");
    add("open", "Open financial exceptions", ex.length, "count", "exceptions");
    add("critical_high", "Critical and high-priority", ex.filter((r) => r.severity === "critical" || r.severity === "high").length, "count", "exceptions");
  }
  return { report, currency: base, from, to, asOf, cutover: CUTOVER, sides: [] as FPSide[], months: [], notes: RC_NOTES.summary, warnings, recordCount: exceptions.length, rows: exceptions, indicators, ...(opts.withParts ? { parts } : {}) };
}
export type Indicator = { currency: string; key: string; label: string; value: number; as: "money" | "count"; report: string; line: string };

/** The records behind one figure: "<section>:<line>", a section, or "all". */
export function rcLinesOf(rows: RCRow[], line: string): RCRow[] {
  if (!line || line === "all") return rows;
  const i = line.indexOf(":");
  const section = i < 0 ? line : line.slice(0, i), key = i < 0 ? undefined : line.slice(i + 1);
  return rows.filter((r) => r.section === section && (key === undefined || r.line === key));
}
export type { FPTotal };
