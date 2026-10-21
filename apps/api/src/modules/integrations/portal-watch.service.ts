import { Types } from "mongoose";
import type { ApprovalRow, ApprovalType } from "@delta/shared";
import { approvalList } from "../approvals/approvals.service";
import { Organization } from "../organization/organization.model";
import { Invoice } from "../invoice/invoice.model";
import { Bill } from "../bill/bill.model";
import { Expense } from "../expense/expense.model";
import { BankTransaction } from "../banking/bank-transaction.model";
import { BalancePaymentModel } from "../balance-payment/balance-payment.model";
import { LateEntryModel } from "../late-entry/late-entry.model";

/**
 * GET /api/v1/service/finance-watch — the Root portal's Pending → Finance tab
 * (the user, 2026-10-17): "approvals pending, or 30 minutes delayed approvals,
 * and old-date transactions entered".
 *
 *   approvals  everything waiting on the Approvals page, every organization —
 *              read as a super admin, so exactly what that page lists — with
 *              how long each has waited since it was sent; past 30 minutes
 *              (around the clock) it is delayed.
 *   backdated  what was entered in the last 30 days with a date of its own at
 *              least a day before the day it was entered (Gulf days): invoice
 *              and bill payments, expenses, bills, invoices, bank and cash
 *              lines typed in. Each says how it got in — typed here, recorded
 *              when an approval went through (the date the CRM or Tetra
 *              Commission gave), or brought from HRMS — and who entered it
 *              where that is kept (an expense's submitter, a late entry's
 *              enterer) — and, past the late-entry limit (Settings → Late
 *              entries, 2026-10-17), the reason given and what a manager made
 *              of it. Late entries waiting for a manager are approvals waiting
 *              too.
 *
 * Read-only.
 */

export const DELAY_MINUTES = 30;
export const BACKDATE_MIN_DAYS = 1;
export const ENTERED_WITHIN_DAYS = 30;
/** The most waiting approvals read per organization (the page's 100 at a time). */
const MAX_PAGES = 10;
const PAGE = 100;
/** A payment recorded within this of an approval going through was recorded by that approval. */
const BY_APPROVAL_MS = 5 * 60_000;
const UAE_MS = 4 * 3_600_000;

const KIND_LABEL: Record<ApprovalType, string> = {
  invoice: "Enrolment invoices",
  fund_request: "Fund requests",
  tetra_deposit: "Tetra Commission deposits",
  balance_payment: "Balance payments",
  expense: "Expense claims",
  bill: "Bills",
  payroll: "Payroll runs",
  procurement: "Purchase requests",
  salary_advance: "Salary advances",
  hiring: "Hiring requests",
};

export type BackdatedKind = "payment" | "bill_payment" | "expense" | "bill" | "invoice" | "bank_line";
const BACKDATED_LABEL: Record<BackdatedKind, string> = {
  payment: "Invoice payments",
  bill_payment: "Bill payments",
  expense: "Expenses",
  bill: "Bills",
  invoice: "Invoices",
  bank_line: "Bank & cash lines",
};
export type Origin = "typed" | "approval" | "hrms";

export interface WatchApproval {
  id: string; type: ApprovalType | "late_entry"; kind: string; title: string; subtitle: string;
  amountMinor?: number; currency?: string; raisedBy: string;
  submittedAt: string; waitingMinutes: number; delayed: boolean;
  orgId: string; orgName: string; href: string;
}
export interface WatchBackdated {
  kind: BackdatedKind; id: string; number: string; title: string;
  date: string; enteredAt: string; daysBack: number;
  amountMinor: number; currency: string; enteredBy: string; origin: Origin;
  /** Past the late-entry limit: the reason given, and where the manager's decision stands. */
  late?: { state: string; reason: string; decidedBy?: string; note?: string };
  orgId: string; orgName: string; href: string;
}
/** A record's own late entry, as the list shows it. */
const lateOf = (v: any): WatchBackdated["late"] => v?.state
  ? { state: String(v.state), reason: String(v.reason ?? ""), ...(v.decidedByName ? { decidedBy: String(v.decidedByName) } : {}), ...(v.decisionNote ? { note: String(v.decisionNote) } : {}) }
  : undefined;

/** The Gulf day of an instant, YYYY-MM-DD. */
const gulfDay = (d: Date | string | undefined | null): string => {
  const t = d ? new Date(d).getTime() : NaN;
  return Number.isFinite(t) ? new Date(t + UAE_MS).toISOString().slice(0, 10) : "";
};
/** An own date's day: a stored instant in Gulf days; a plain YYYY-MM-DD as it is. */
const ownDay = (d: Date | string | undefined | null): string =>
  typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : gulfDay(d);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

async function waitingIn(org: { _id: Types.ObjectId; name: string }, now: number): Promise<{ rows: WatchApproval[]; unavailable: string[] }> {
  const auth = { userId: new Types.ObjectId().toString(), organizationId: String(org._id), role: "", permissions: [], isSuperAdmin: true };
  const rows: ApprovalRow[] = [];
  const unavailable = new Set<string>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await approvalList(auth, { status: "pending", page, pageSize: PAGE });
    rows.push(...r.rows);
    for (const u of r.meta.unavailable) unavailable.add(u);
    if (page >= r.meta.pageCount) break;
  }
  const late = (await LateEntryModel.find({ organizationId: org._id, state: "pending" })
    .select("number title amountMinor currency enteredByName createdAt kind").lean()) as any[];
  const lateRows: WatchApproval[] = late.map((l) => {
    const since = new Date(l.createdAt).toISOString();
    const waitingMinutes = Math.max(0, Math.floor((now - Date.parse(since)) / 60_000));
    return {
      id: String(l._id), type: "late_entry", kind: "Late entries", title: [l.number, l.title].filter(Boolean).join(" · "), subtitle: String(l.kind ?? "").replace(/_/g, " "),
      amountMinor: l.amountMinor, currency: l.currency, raisedBy: l.enteredByName ?? "", submittedAt: since, waitingMinutes,
      delayed: waitingMinutes > DELAY_MINUTES, orgId: String(org._id), orgName: org.name, href: "/late-entries",
    };
  });
  return {
    unavailable: [...unavailable].map((u) => `${org.name} — ${u}`),
    rows: [...lateRows, ...rows.filter((r) => r.status === "pending").map((r) => {
      const since = r.submittedAt ?? r.at ?? "";
      const waitingMinutes = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 60_000)) : 0;
      return {
        id: r.id, type: r.type, kind: KIND_LABEL[r.type] ?? r.type, title: r.title, subtitle: r.subtitle,
        amountMinor: r.amountMinor, currency: r.currency, raisedBy: r.raisedBy ?? "",
        submittedAt: since, waitingMinutes, delayed: waitingMinutes > DELAY_MINUTES,
        orgId: String(org._id), orgName: org.name, href: r.href,
      };
    })],
  };
}

export async function backdatedIn(org: { _id: Types.ObjectId; name: string }, since: Date): Promise<WatchBackdated[]> {
  const out: WatchBackdated[] = [];
  const orgId = org._id;
  const push = (x: Omit<WatchBackdated, "daysBack" | "orgId" | "orgName">) => {
    const own = ownDay(x.date), entered = gulfDay(x.enteredAt);
    if (!own || !entered) return;
    const daysBack = daysBetween(own, entered);
    if (daysBack < BACKDATE_MIN_DAYS) return;
    out.push({ ...x, date: own, daysBack, orgId: String(orgId), orgName: org.name });
  };

  const [invoices, bills, expenses, lines, balanceDecisions] = await Promise.all([
    Invoice.find({ organizationId: orgId, $or: [{ createdAt: { $gte: since } }, { "payments.createdAt": { $gte: since } }] })
      .select("invoiceNumber customerName totalMinor currency issueDate createdAt external.source approval.at payments").lean(),
    Bill.find({ organizationId: orgId, $or: [{ createdAt: { $gte: since } }, { "payments.createdAt": { $gte: since } }] })
      .select("billNumber vendorName totalMinor currency billDate createdAt payments lateEntry").lean(),
    Expense.find({ organizationId: orgId, createdAt: { $gte: since } })
      .select("expenseNumber description categoryName totalMinor currency expenseDate createdAt submittedByName source.kind lateEntry").lean(),
    BankTransaction.find({ organizationId: orgId, source: "manual", createdAt: { $gte: since }, "matches.0": { $exists: false } })
      .select("accountId accountName description reference amountMinor currency type date createdAt lateEntry").lean(),
    // Balance payments decided lately: the payments those approvals recorded on their invoices.
    BalancePaymentModel.find({ organizationId: orgId, "decision.decidedAt": { $gte: new Date(since.getTime() - BY_APPROVAL_MS) } })
      .select("invoiceId decision.decidedAt").lean(),
  ]);

  const decidedAt = new Map<string, number[]>();
  for (const b of balanceDecisions as any[]) {
    const t = b.decision?.decidedAt ? new Date(b.decision.decidedAt).getTime() : NaN;
    if (Number.isFinite(t)) decidedAt.set(String(b.invoiceId), [...(decidedAt.get(String(b.invoiceId)) ?? []), t]);
  }
  const near = (t: number, ats: number[]) => ats.some((a) => Math.abs(a - t) <= BY_APPROVAL_MS);

  for (const inv of invoices as any[]) {
    const fromOutside = !!inv.external?.source;
    if (new Date(inv.createdAt) >= since) {
      push({
        kind: "invoice", id: String(inv._id), number: inv.invoiceNumber, title: inv.customerName ?? "", date: inv.issueDate,
        enteredAt: new Date(inv.createdAt).toISOString(), amountMinor: inv.totalMinor ?? 0, currency: inv.currency ?? "",
        enteredBy: "", origin: fromOutside ? "approval" : "typed", href: `/invoices/${inv._id}`,
      });
    }
    const approvedAt = inv.approval?.at ? [new Date(inv.approval.at).getTime()] : [];
    for (const p of inv.payments ?? []) {
      if (!p.createdAt || new Date(p.createdAt) < since) continue;
      const t = new Date(p.createdAt).getTime();
      const byApproval = !!p.externalRef || near(t, approvedAt) || near(t, decidedAt.get(String(inv._id)) ?? []);
      push({
        kind: "payment", id: `${inv._id}:${p._id ?? t}`, number: p.receiptNumber || inv.invoiceNumber, title: `${inv.customerName ?? ""} · ${inv.invoiceNumber}`,
        date: p.paidOn, enteredAt: new Date(p.createdAt).toISOString(), amountMinor: p.amountMinor ?? 0, currency: inv.currency ?? "",
        enteredBy: p.lateEntry?.enteredByName ?? "", origin: byApproval ? "approval" : "typed", late: lateOf(p.lateEntry), href: `/invoices/${inv._id}`,
      });
    }
  }
  for (const b of bills as any[]) {
    if (new Date(b.createdAt) >= since) {
      push({
        kind: "bill", id: String(b._id), number: b.billNumber, title: b.vendorName ?? "", date: b.billDate,
        enteredAt: new Date(b.createdAt).toISOString(), amountMinor: b.totalMinor ?? 0, currency: b.currency ?? "",
        enteredBy: b.lateEntry?.enteredByName ?? "", origin: "typed", late: lateOf(b.lateEntry), href: `/bills/${b._id}`,
      });
    }
    for (const p of b.payments ?? []) {
      if (!p.createdAt || new Date(p.createdAt) < since) continue;
      push({
        kind: "bill_payment", id: `${b._id}:${p._id ?? p.createdAt}`, number: b.billNumber, title: b.vendorName ?? "", date: p.paidOn,
        enteredAt: new Date(p.createdAt).toISOString(), amountMinor: p.amountMinor ?? 0, currency: b.currency ?? "",
        enteredBy: p.lateEntry?.enteredByName ?? "", origin: "typed", late: lateOf(p.lateEntry), href: `/bills/${b._id}`,
      });
    }
  }
  for (const e of expenses as any[]) {
    push({
      kind: "expense", id: String(e._id), number: e.expenseNumber, title: [e.categoryName, e.description].filter(Boolean).join(" · "), date: e.expenseDate,
      enteredAt: new Date(e.createdAt).toISOString(), amountMinor: e.totalMinor ?? 0, currency: e.currency ?? "",
      enteredBy: e.lateEntry?.enteredByName || e.submittedByName || "", origin: e.source?.kind ? "hrms" : "typed", late: lateOf(e.lateEntry), href: `/expenses/${e._id}`,
    });
  }
  for (const l of lines as any[]) {
    push({
      kind: "bank_line", id: String(l._id), number: l.reference || "", title: `${l.accountName} · ${l.description}`, date: l.date,
      enteredAt: new Date(l.createdAt).toISOString(), amountMinor: (l.type === "debit" ? -1 : 1) * (l.amountMinor ?? 0), currency: l.currency ?? "",
      enteredBy: l.lateEntry?.enteredByName ?? "", origin: "typed", late: lateOf(l.lateEntry), href: `/banking/${l.accountId}`,
    });
  }
  return out;
}

export async function financeWatchForPortal(now = Date.now()) {
  const orgs = (await Organization.find().select("name").lean()) as unknown as { _id: Types.ObjectId; name: string }[];
  const since = new Date(now - ENTERED_WITHIN_DAYS * 86_400_000);
  const [waiting, backdated] = await Promise.all([
    Promise.all(orgs.map((o) => waitingIn(o, now))),
    Promise.all(orgs.map((o) => backdatedIn(o, since))),
  ]);

  const approvals = waiting.flatMap((w) => w.rows).sort((a, b) => b.waitingMinutes - a.waitingMinutes);
  const byKind = new Map<string, { type: string; label: string; total: number; delayed: number }>();
  for (const a of approvals) {
    const k = byKind.get(a.type) ?? { type: a.type, label: a.kind, total: 0, delayed: 0 };
    k.total++;
    if (a.delayed) k.delayed++;
    byKind.set(a.type, k);
  }
  const entries = backdated.flat().sort((a, b) => b.enteredAt.localeCompare(a.enteredAt));
  const entryKinds = new Map<string, { kind: string; label: string; total: number; typed: number }>();
  for (const e of entries) {
    const k = entryKinds.get(e.kind) ?? { kind: e.kind, label: BACKDATED_LABEL[e.kind], total: 0, typed: 0 };
    k.total++;
    if (e.origin === "typed") k.typed++;
    entryKinds.set(e.kind, k);
  }

  return {
    generatedAt: new Date(now).toISOString(),
    rules: { delayMinutes: DELAY_MINUTES, backdateMinDays: BACKDATE_MIN_DAYS, enteredWithinDays: ENTERED_WITHIN_DAYS },
    organizations: orgs.map((o) => ({ id: String(o._id), name: o.name })),
    approvals: {
      total: approvals.length,
      delayed: approvals.filter((a) => a.delayed).length,
      byKind: [...byKind.values()].sort((a, b) => b.total - a.total),
      unavailable: waiting.flatMap((w) => w.unavailable),
      rows: approvals,
    },
    backdated: {
      total: entries.length,
      typed: entries.filter((e) => e.origin === "typed").length,
      lateWaiting: entries.filter((e) => e.late?.state === "pending").length,
      byKind: [...entryKinds.values()].sort((a, b) => b.total - a.total),
      rows: entries,
    },
  };
}
