import { Types } from "mongoose";
import { isVatFreeMethod, paidAmountMinor, paidCurrency, PAYMENT_METHOD_LABELS, type PaymentMethod } from "@delta/shared";
import { Invoice } from "../invoice/invoice.model";
import { Bill } from "../bill/bill.model";
import { Expense } from "../expense/expense.model";
import { PayrollRun } from "../payroll/payroll-run.model";
import { payrollMonthEnd } from "../payroll/payroll-month";
import { CommissionRecord } from "../commission/commission-record.model";
import { CrmCommissionPayout } from "../crm-commission/crm-commission-payout.model";
import { CsCommissionPayout } from "../cs-commission/cs-commission-payout.model";
import { BankTransaction } from "../banking/bank-transaction.model";
import { categoryNameMap, pnlExpenseFilter } from "../expense-category/expense-category.service";
import { baseCurrencyOf, crmOf, periodCreditNotes, periodVendorCredits } from "./reports.service";

/*
 * Management profitability (Phase 3, 2026-11-27) — three views beside finance's Profit & Loss, which is left as it is:
 *
 *   invoice     income = invoices issued before VAT, less credit notes (the P&L's invoiced income), less the costs
 *               incurred in the period. Management figures, not statutory accrual accounts.
 *   collection  income = payments received in the period without their VAT, less the same incurred costs. Collections
 *               can be for invoices of earlier periods. Not accounting profit.
 *   cash        money in less money out on the bank lines of the period; transfers between the organization's own
 *               accounts left out. Nothing unpaid or uncollected is in it.
 *
 * Costs incurred (the user approved, 2026-11-27):
 *   payroll     each person's payable on a run that is approved, part paid or paid, in the run's month — whether paid
 *               or not. The payments' own expenses are not counted beside it (they would be the same money twice).
 *               Gross, deductions, advance and loan recoveries and net are shown beside it, never added in.
 *   commission  outside payroll: CRM / CS payouts approved or paid, in their earning month; finance's own commission
 *               records earned or paid, when worked out. One taken into a payroll run is in payroll (shown as "of which
 *               commission"), and an expense written when one was paid directly is not counted beside it. Pending
 *               eligibility and earned-not-approved live in the CRMs, not here. Typed expenses filed under Sales
 *               Commission count here too.
 *   supplier    bills by bill date before VAT, less vendor credits (Phase 2B); bill mirror expenses never.
 *               Bonuses and one-time payments typed under Payroll & Employee Benefits count as payroll, by their date.
 *   other       every other expense the P&L counts, by its date.
 *
 * Each amount stays in its own currency; the organization's is the figure, every other one is apart, never converted.
 * Read-only: nothing here writes.
 */

export type MPView = "invoice" | "collection" | "cash";
export type MPGroup = "income" | "payroll" | "commission" | "supplier" | "other";
export const MP_GROUPS: MPGroup[] = ["income", "payroll", "commission", "supplier", "other"];

export type MPRow = {
  id: string; date: string; month: string; number: string; title: string; detail: string;
  group: MPGroup; kind: string; category: string; status: string;
  amountMinor: number; paidMinor: number; unpaidMinor: number; currency: string; href: string;
  vatMinor?: number; grossMinor?: number; crm?: string; method?: string;
};

type Sum = { total: number; paid: number; unpaid: number; count: number };
export type MPSide = { currency: string; income: Sum; payroll: Sum; commission: Sum; supplier: Sum; other: Sum; expenses: Sum; netMinor: number; marginPct: number | null };
export type PayrollDetail = { currency: string; people: number; grossMinor: number; deductionsMinor: number; recoveriesMinor: number; netMinor: number; additionsMinor: number; commissionMinor: number; payableMinor: number; paidMinor: number; outstandingMinor: number; onHold: number; onHoldMinor: number };
export type CommissionDetail = { currency: string; approvedUnpaidMinor: number; paidMinor: number; earnedMinor: number; typedMinor: number; inPayrollMinor: number; count: number };

const oid = (id: string) => new Types.ObjectId(id);
const startOf = (d: string) => new Date(`${d}T00:00:00.000Z`);
const endOf = (d: string) => new Date(`${d}T23:59:59.999Z`);
const day = (d: unknown) => new Date(d as Date).toISOString().slice(0, 10);
const COMMISSION_SOURCES = new Set(["commission", "crm_commission", "cs_commission", "crm_slab"]);
/** Deductions that pay back money the company already gave (an advance or a loan), by what HRMS calls them. */
const RECOVERY = /advance|loan/i;
const LIVE_RUN = ["approved", "partially_paid", "paid"];

/** Every record behind one view for the period, in every currency — the totals are sums of these. */
export async function managementRows(orgId: string, from: string, to: string, view: MPView): Promise<{ base: string; rows: MPRow[]; payroll: PayrollDetail[]; commission: CommissionDetail[]; duplicates: number }> {
  const base = (await baseCurrencyOf(orgId)).toUpperCase();
  const cur = (c: unknown) => String(c || base).toUpperCase();
  const range = { $gte: startOf(from), $lte: endOf(to) };
  const lo = range.$gte.getTime(), hi = range.$lte.getTime();
  const within = (d: unknown) => { const t = new Date(d as Date).getTime(); return t >= lo && t <= hi; };
  const monthIn = (m: string) => /^\d{4}-\d{2}$/.test(m) && within(payrollMonthEnd(m));
  const rows: MPRow[] = [];

  if (view === "cash") {
    const lines = await BankTransaction.find({ organizationId: oid(orgId), date: range, "transfer.id": { $exists: false } })
      .select("date accountName currency description reference amountMinor status matches").lean<any[]>();
    // A line paying an expense filed under Sales Commission is commission money.
    const expenseIds = lines.flatMap((l) => (l.matches ?? []).filter((m: any) => m.type === "expense").map((m: any) => m.referenceId)).filter((x: string) => Types.ObjectId.isValid(x));
    const commissionExpenses = new Set((await Expense.find({ _id: { $in: expenseIds }, category: "sales_commission" }).select("_id").lean<any[]>()).map((e) => String(e._id)));
    let duplicates = 0;
    for (const l of lines) {
      const amount = Number(l.amountMinor) || 0;
      if (!amount) continue;
      const m = (l.matches ?? [])[0];
      const type = m?.type as string | undefined;
      // Each line counts with its kind: a payroll, bill or expense payment coming back (reversed) takes off that kind's
      // money out; money going back to a customer takes off money in. Only lines tied to nothing stay as they are.
      const costKind: MPGroup | null = type === "payroll" ? "payroll" : type === "bill" ? "supplier"
        : type === "expense" ? (commissionExpenses.has(String(m.referenceId)) ? "commission" : "other") : null;
      const group: MPGroup = type === "invoice" ? "income" : costKind ?? (amount > 0 ? "income" : "other");
      const signed = group === "income" ? amount : -amount; // money in as plus; money out as plus on its cost line
      const category = type === "invoice" ? (amount > 0 ? "Customer payments" : "Money back to customers")
        : costKind ? `${costKind === "payroll" ? "Payroll" : costKind === "supplier" ? "Supplier bills" : costKind === "commission" ? "Commission" : "Expenses"}${amount > 0 ? " (reversed, back in)" : ""}`
        : "Not matched to a record";
      if (l.status === "duplicate") duplicates++;
      const date = day(l.date);
      rows.push({
        id: String(l._id), date, month: date.slice(0, 7), number: m?.referenceNumber || l.reference || "", title: l.description || "", detail: [l.accountName, l.status === "duplicate" ? "marked duplicate (still in the balance)" : ""].filter(Boolean).join(" · "),
        group, kind: "bank line", category, status: l.status === "duplicate" ? "Marked duplicate" : "Moved",
        amountMinor: signed, paidMinor: signed, unpaidMinor: 0, currency: cur(l.currency), href: `/banking`,
      });
    }
    return { base, rows, payroll: [], commission: [], duplicates };
  }

  // ── Income ────────────────────────────────────────────────────────────────
  const INV = "invoiceNumber customerName salespersonName issueDate status currency subtotalMinor taxTotalMinor totalMinor enrolment.crm external.source proforma payments._id payments.paidOn payments.amountMinor payments.method payments.original payments.bankCurrency payments.bankAmountMinor payments.taxInvoice payments.receiptNumber";
  if (view === "invoice") {
    // As the P&L's invoiced income (computePL): before VAT; a part paid in another currency comes out at what it was
    // recorded as and is apart, in that currency; less the credit notes issued in the period.
    const invoices = await Invoice.find({ organizationId: oid(orgId), issueDate: range, status: { $nin: ["draft", "void"] } }).select(INV).lean<any[]>();
    for (const inv of invoices) {
      const invCurrency = cur(inv.currency);
      const date = day(inv.issueDate);
      const head = {
        id: String(inv._id), date, month: date.slice(0, 7), number: inv.invoiceNumber, title: inv.customerName ?? "", detail: inv.salespersonName ?? "",
        group: "income" as const, kind: "invoice", category: "Invoice revenue", status: "Issued", paidMinor: 0, unpaidMinor: 0,
        href: `/invoices/${inv._id}`, vatMinor: (inv.totalMinor ?? 0) - (inv.subtotalMinor ?? 0), grossMinor: inv.totalMinor ?? 0, crm: crmOf(inv),
      };
      // An invoice in another currency is that currency's income, whole, as the P&L keeps it.
      if (invCurrency !== base) { rows.push({ ...head, amountMinor: Number(inv.subtotalMinor) || 0, currency: invCurrency }); continue; }
      let away = 0;
      for (const p of inv.payments ?? []) {
        const paidIn = paidCurrency(p, invCurrency);
        const paid = paidIn ? paidAmountMinor(p, invCurrency) : 0;
        if (!paidIn || paid <= 0) continue;
        away += Number(p.amountMinor) || 0;
        rows.push({
          id: `${inv._id}:${p._id}`, date, month: date.slice(0, 7), number: inv.invoiceNumber, title: inv.customerName ?? "", detail: `Paid in ${paidIn} on ${inv.invoiceNumber}`,
          group: "income", kind: "invoice", category: "Invoice revenue", status: "Issued", amountMinor: paid, paidMinor: 0, unpaidMinor: 0, currency: paidIn, href: `/invoices/${inv._id}`, crm: crmOf(inv),
        });
      }
      rows.push({ ...head, amountMinor: Math.max(0, (Number(inv.subtotalMinor) || 0) - away), currency: base, ...(away ? { detail: `Less ${away / 100} paid in another currency, shown apart` } : {}) });
    }
    for (const n of await periodCreditNotes(orgId, from, to)) {
      const date = day(n.issuedAt);
      rows.push({
        id: `cn:${n._id}`, date, month: date.slice(0, 7), number: n.creditNoteNumber, title: n.customerName ?? "", detail: `Credit note on ${n.invoiceNumber}`,
        group: "income", kind: "credit note", category: "Less credit notes", status: "Issued", amountMinor: -(Number(n.subtotalMinor) || 0), paidMinor: 0, unpaidMinor: 0,
        currency: cur(n.currency), href: `/credit-notes/${n._id}`, vatMinor: -(Number(n.taxTotalMinor) || 0),
      });
    }
  } else {
    // Payments received in the period, without their VAT: a tax-invoice payment without its own VAT; any other
    // payment without its share of the invoice's VAT. A payment made in another currency carries none (rupees on an
    // AED invoice) and is apart, as paid. Finance records no refunds, and every receipt here is a customer's payment.
    const invoices = await Invoice.find({ organizationId: oid(orgId), status: { $nin: ["draft", "void"] }, payments: { $elemMatch: { paidOn: range } } }).select(INV).lean<any[]>();
    for (const inv of invoices) {
      const invCurrency = cur(inv.currency);
      const total = Number(inv.totalMinor) || 0, tax = Number(inv.taxTotalMinor) || 0;
      for (const p of inv.payments ?? []) {
        if (!within(p.paidOn)) continue;
        const date = day(p.paidOn);
        const amount = Number(p.amountMinor) || 0;
        const paidIn = paidCurrency(p, invCurrency);
        const paid = paidIn ? paidAmountMinor(p, invCurrency) : 0;
        const common = {
          id: `${inv._id}:${p._id}`, date, month: date.slice(0, 7), number: p.taxInvoice?.number || p.receiptNumber || inv.invoiceNumber, title: inv.customerName ?? "",
          group: "income" as const, kind: "payment", category: "Collections", status: "Received", paidMinor: 0, unpaidMinor: 0, href: `/invoices/${inv._id}`, crm: crmOf(inv),
          method: PAYMENT_METHOD_LABELS[p.method as PaymentMethod] ?? String(p.method ?? ""),
        };
        if (paidIn && paid > 0) { rows.push({ ...common, detail: `Towards ${inv.invoiceNumber}, paid in ${paidIn} (no VAT)`, amountMinor: paid, currency: paidIn, vatMinor: 0, grossMinor: paid }); continue; }
        // A method that carries no VAT (Tabby DGO) has none to take off.
        const vat = isVatFreeMethod(p.method) ? 0 : p.taxInvoice?.number ? Number(p.taxInvoice.taxMinor) || 0 : total > 0 ? Math.round((amount * tax) / total) : 0;
        rows.push({ ...common, detail: `Towards ${inv.invoiceNumber} (issued ${day(inv.issueDate)})`, amountMinor: amount - vat, currency: invCurrency, vatMinor: vat, grossMinor: amount });
      }
    }
  }

  // ── Payroll ───────────────────────────────────────────────────────────────
  const runs = await PayrollRun.find({ organizationId: oid(orgId), status: { $in: LIVE_RUN } }).select("runNumber period status currency lines adjustments").lean<any[]>();
  const counted = runs.filter((r) => monthIn(r.period));
  const payDetail = new Map<string, PayrollDetail>();
  const commissionOnRuns = { records: new Set<string>(), crm: new Set<string>(), cs: new Set<string>() };
  for (const r of runs) for (const a of r.adjustments ?? []) {
    for (const id of a.commissionRecordIds ?? []) commissionOnRuns.records.add(String(id));
    for (const id of a.crmPayoutIds ?? []) commissionOnRuns.crm.add(String(id));
    for (const id of a.csPayoutIds ?? []) commissionOnRuns.cs.add(String(id));
  }
  for (const r of counted) {
    const date = day(payrollMonthEnd(r.period));
    for (const l of r.lines ?? []) {
      const currency = cur(l.currency || r.currency);
      const payable = Number(l.payableMinor) || 0;
      const paid = Math.min(Number(l.amountPaidMinor) || 0, Math.max(payable, 0));
      const recoveries = (l.deductions ?? []).filter((d: any) => RECOVERY.test(String(d.label ?? ""))).reduce((n: number, d: any) => n + (Number(d.amountMinor) || 0), 0);
      const mine = (r.adjustments ?? []).filter((a: any) => String(a.lineId) === String(l._id));
      const commission = mine.filter((a: any) => COMMISSION_SOURCES.has(a.source)).reduce((n: number, a: any) => n + (a.kind === "deduction" ? -1 : 1) * (Number(a.amountMinor) || 0), 0);
      const held = l.status === "on_hold";
      const d = payDetail.get(currency) ?? { currency, people: 0, grossMinor: 0, deductionsMinor: 0, recoveriesMinor: 0, netMinor: 0, additionsMinor: 0, commissionMinor: 0, payableMinor: 0, paidMinor: 0, outstandingMinor: 0, onHold: 0, onHoldMinor: 0 };
      d.people++; d.grossMinor += Number(l.grossMinor) || 0; d.deductionsMinor += Number(l.deductionsMinor) || 0; d.recoveriesMinor += recoveries;
      d.netMinor += Number(l.netFromHrmsMinor) || 0; d.additionsMinor += Number(l.adjustmentsMinor) || 0; d.commissionMinor += commission;
      d.payableMinor += payable; d.paidMinor += paid; d.outstandingMinor += payable - paid;
      if (held) { d.onHold++; d.onHoldMinor += payable - paid; }
      payDetail.set(currency, d);
      rows.push({
        id: `${r._id}:${l._id}`, date, month: r.period, number: r.runNumber, title: l.name ?? "", group: "payroll", kind: "salary", category: l.departmentName || "No department",
        detail: [`Payroll for ${r.period}`, `gross ${(Number(l.grossMinor) || 0) / 100}`, `deductions ${(Number(l.deductionsMinor) || 0) / 100}${recoveries ? ` (of which advance/loan recoveries ${recoveries / 100})` : ""}`, `additions ${(Number(l.adjustmentsMinor) || 0) / 100}${commission ? ` (of which commission ${commission / 100})` : ""}`].join(" · "),
        status: held ? "On hold" : paid >= payable ? "Paid" : paid > 0 ? "Part paid" : "Not paid",
        amountMinor: payable, paidMinor: paid, unpaidMinor: payable - paid, currency, href: `/payroll/${r._id}`,
      });
    }
  }

  // ── Commission outside payroll ────────────────────────────────────────────
  const commissionExpenseIds = new Set<string>();
  const comDetail = new Map<string, CommissionDetail>();
  const comAdd = (currency: string, f: (d: CommissionDetail) => void) => {
    const d = comDetail.get(currency) ?? { currency, approvedUnpaidMinor: 0, paidMinor: 0, earnedMinor: 0, typedMinor: 0, inPayrollMinor: 0, count: 0 };
    f(d); comDetail.set(currency, d);
  };
  for (const d of payDetail.values()) comAdd(d.currency, (c) => { c.inPayrollMinor += d.commissionMinor; });
  const payouts = [
    ...(await CrmCommissionPayout.find({ organizationId: oid(orgId), state: { $in: ["approved", "paid"] } }).select("crmName month personName currency amountMinor state expenseId payrollRunId").lean<any[]>()).map((p) => ({ ...p, which: "crm" as const, monthOf: p.month as string, label: `CRM commission${p.crmName ? ` · ${p.crmName}` : ""}` })),
    ...(await CsCommissionPayout.find({ organizationId: oid(orgId), state: { $in: ["approved", "paid"] } }).select("kind lastMonth personName currency amountMinor state expenseId payrollRunId").lean<any[]>()).map((p) => ({ ...p, which: "cs" as const, monthOf: p.lastMonth as string, label: `CS commission (${p.kind})` })),
  ];
  for (const p of payouts) {
    if (p.expenseId) commissionExpenseIds.add(String(p.expenseId));
    if (p.payrollRunId || commissionOnRuns[p.which as "crm" | "cs"].has(String(p._id)) || !monthIn(p.monthOf)) continue;
    const currency = cur(p.currency);
    const amount = Number(p.amountMinor) || 0;
    const paid = p.state === "paid" ? amount : 0;
    comAdd(currency, (c) => { c.count++; if (paid) c.paidMinor += amount; else c.approvedUnpaidMinor += amount; });
    rows.push({
      id: `${p.which}:${p._id}`, date: day(payrollMonthEnd(p.monthOf)), month: p.monthOf, number: "", title: p.personName ?? "", detail: `${p.label}, earned ${p.monthOf}${p.expenseId ? " · paid directly" : ""}`,
      group: "commission", kind: `${p.which} payout`, category: p.which === "crm" ? "CRM commission" : "CS commission", status: paid ? "Paid" : "Approved, not paid",
      amountMinor: amount, paidMinor: paid, unpaidMinor: amount - paid, currency, href: p.which === "crm" ? "/commissions/crm" : "/commissions/cs",
    });
  }
  const records = await CommissionRecord.find({ organizationId: oid(orgId), status: { $in: ["earned", "paid"] } }).select("salespersonName invoiceNumber commissionMinor status calculatedAt paidExpenseId payrollRunId").lean<any[]>();
  for (const r of records) {
    if (r.paidExpenseId) commissionExpenseIds.add(String(r.paidExpenseId));
    if (r.payrollRunId || commissionOnRuns.records.has(String(r._id)) || !within(r.calculatedAt)) continue;
    const amount = Number(r.commissionMinor) || 0;
    const paid = r.status === "paid" ? amount : 0;
    comAdd(base, (c) => { c.count++; if (paid) c.paidMinor += amount; else c.earnedMinor += amount; });
    const date = day(r.calculatedAt);
    rows.push({
      id: `rec:${r._id}`, date, month: date.slice(0, 7), number: r.invoiceNumber ?? "", title: r.salespersonName ?? "", detail: `Commission on ${r.invoiceNumber}`,
      group: "commission", kind: "commission record", category: "Finance commission", status: paid ? "Paid" : "Earned, not paid",
      amountMinor: amount, paidMinor: paid, unpaidMinor: amount - paid, currency: base, href: "/commissions",
    });
  }

  // ── Supplier ──────────────────────────────────────────────────────────────
  const bills = await Bill.find({ organizationId: oid(orgId), billDate: range, status: { $nin: ["draft", "voided"] } })
    .select("billNumber vendorName billDate status currency subtotalMinor taxTotalMinor totalMinor payments.amountMinor categoryName").lean<any[]>();
  for (const b of bills) {
    const subtotal = Number(b.subtotalMinor) || 0, total = Number(b.totalMinor) || 0;
    const cash = (b.payments ?? []).reduce((n: number, p: any) => n + (Number(p.amountMinor) || 0), 0);
    const paid = total > 0 ? Math.min(subtotal, Math.round((subtotal * cash) / total)) : 0;
    const date = day(b.billDate);
    rows.push({
      id: String(b._id), date, month: date.slice(0, 7), number: b.billNumber, title: b.vendorName ?? "", detail: "Supplier bill, before VAT",
      group: "supplier", kind: "bill", category: b.categoryName || "Supplier bills", status: paid >= subtotal ? "Paid" : paid > 0 ? "Part paid" : "Not paid",
      amountMinor: subtotal, paidMinor: paid, unpaidMinor: subtotal - paid, currency: cur(b.currency), href: `/bills/${b._id}`, vatMinor: total - subtotal, grossMinor: total,
    });
  }
  for (const v of await periodVendorCredits(orgId, from, to)) {
    const date = day(v.issueDate);
    const net = Number(v.subtotalMinor) || 0;
    // A credit takes off what is still owed to the supplier (before VAT); no money moves.
    rows.push({
      id: `vc:${v._id}`, date, month: date.slice(0, 7), number: v.creditNumber, title: v.vendorName ?? "", detail: v.sourceBillNumber ? `Vendor credit on ${v.sourceBillNumber}` : "Vendor credit",
      group: "supplier", kind: "vendor credit", category: "Less vendor credits", status: "Credit", amountMinor: -net, paidMinor: 0, unpaidMinor: -net, currency: cur(v.currency), href: `/vendor-credits/${v._id}`,
    });
  }

  // ── Other operating expenses (and typed Sales Commission) ─────────────────
  const [pnl, nameMap] = await Promise.all([pnlExpenseFilter(orgId), categoryNameMap(orgId)]);
  const expenses = await Expense.find({ organizationId: oid(orgId), status: { $in: ["approved", "submitted"] }, expenseDate: range, "source.kind": { $nin: ["bill", "payroll"] }, ...pnl })
    .select("expenseNumber category subcategoryName description expenseDate paidOn totalMinor currency status source.kind").lean<any[]>();
  for (const e of expenses) {
    if (commissionExpenseIds.has(String(e._id))) continue; // its payout or record is counted above
    const currency = cur(e.currency);
    const amount = Number(e.totalMinor) || 0;
    const paid = e.paidOn ? amount : 0;
    const isCommission = e.category === "sales_commission";
    // Bonuses and one-time payments typed under Payroll & Employee Benefits are payroll cost, outside a run.
    const isPayroll = e.category === "payroll_benefits";
    if (isCommission) comAdd(currency, (c) => { c.count++; c.typedMinor += amount; });
    const date = day(e.expenseDate);
    rows.push({
      id: String(e._id), date, month: date.slice(0, 7), number: e.expenseNumber ?? "", title: e.description || (nameMap.get(e.category) ?? e.category),
      detail: [e.subcategoryName, e.status === "submitted" ? "waiting for approval" : ""].filter(Boolean).join(" · "),
      group: isCommission ? "commission" : isPayroll ? "payroll" : "other", kind: isPayroll ? "payroll expense" : "expense", category: nameMap.get(e.category) ?? e.category, status: paid ? "Paid" : "Not paid",
      amountMinor: amount, paidMinor: paid, unpaidMinor: amount - paid, currency, href: `/expenses/${e._id}`,
    });
  }

  return { base, rows, payroll: [...payDetail.values()], commission: [...comDetail.values()], duplicates: 0 };
}

const zero = (): Sum => ({ total: 0, paid: 0, unpaid: 0, count: 0 });

/** The view's figures per currency, from its rows: income, each kind of cost (paid and unpaid), net profit, margin. */
export function sidesOf(rows: MPRow[], base: string): MPSide[] {
  const by = new Map<string, MPSide>();
  for (const r of rows) {
    const s = by.get(r.currency) ?? { currency: r.currency, income: zero(), payroll: zero(), commission: zero(), supplier: zero(), other: zero(), expenses: zero(), netMinor: 0, marginPct: null };
    const add = (x: Sum) => { x.total += r.amountMinor; x.paid += r.paidMinor; x.unpaid += r.unpaidMinor; x.count++; };
    add(s[r.group]);
    if (r.group !== "income") add(s.expenses);
    by.set(r.currency, s);
  }
  for (const s of by.values()) {
    s.netMinor = s.income.total - s.expenses.total;
    s.marginPct = s.income.total > 0 ? Math.round((s.netMinor / s.income.total) * 1000) / 10 : null;
  }
  return [...by.values()].sort((a, b) => (a.currency === base ? -1 : b.currency === base ? 1 : a.currency.localeCompare(b.currency)));
}

/** The months of from..to ("2026-10"), at most 24. */
export function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from.slice(0, 7)}-01T00:00:00Z`); d.toISOString().slice(0, 10) <= to && out.length < 24; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) out.push(d.toISOString().slice(0, 7));
  return out;
}

export const VIEW_NOTES: Record<MPView, string[]> = {
  invoice: [
    "Invoice-based management profitability: invoices issued before VAT, less credit notes, less the costs incurred in the period. A management view, not statutory accrual profit.",
    "Payroll is each person's payable in the payroll month, paid or not. Employer costs (contributions, benefits) are not recorded in finance.",
  ],
  collection: [
    "Collection-based management profitability: payments received in the period without their VAT, less the costs incurred in the period. Not accounting profit.",
    "Collections can be for invoices issued in earlier periods, so income and costs may not belong to the same sales.",
    "Payroll is each person's payable in the payroll month, paid or not. Employer costs are not recorded in finance.",
  ],
  cash: [
    "Cash movement: money in less money out on the bank lines of the period, by account currency. Transfers between the organization's own accounts are left out; nothing unpaid or uncollected is in it.",
    "Lines not matched to a record are shown as such. A line marked duplicate still counts, as it does in the account balance.",
  ],
};

/** One view: its figures per currency for the period, month by month, and the payroll and commission detail. */
export async function getManagementProfit(orgId: string, from: string, to: string, view: MPView) {
  const { base, rows, payroll, commission, duplicates } = await managementRows(orgId, from, to, view);
  const months = monthsOf(from, to).map((month) => ({ month, sides: sidesOf(rows.filter((r) => r.month === month), base) }));
  return { view, currency: base, from, to, sides: sidesOf(rows, base), months, payroll, commission, notes: VIEW_NOTES[view], duplicates, recordCount: rows.length };
}

/** "income", "payroll", "commission", "supplier", "other", or "expenses" for every cost. */
export const MP_LINES = ["income", "payroll", "commission", "supplier", "other", "expenses"] as const;
export type MPLine = (typeof MP_LINES)[number];

/** The records behind one figure of a view, in the organization's currency (other currencies are apart on the view). */
export async function managementLines(orgId: string, from: string, to: string, view: MPView, line: MPLine): Promise<{ currency: string; rows: MPRow[]; totalMinor: number }> {
  const { base, rows } = await managementRows(orgId, from, to, view);
  const kept = rows.filter((r) => r.currency === base && (line === "expenses" ? r.group !== "income" : r.group === line));
  kept.sort((a, b) => b.date.localeCompare(a.date) || b.amountMinor - a.amountMinor);
  return { currency: base, rows: kept, totalMinor: kept.reduce((n, r) => n + r.amountMinor, 0) };
}
