import { Types } from "mongoose";
import {
  DEFAULT_LATE_ENTRY_DAYS, LATE_ENTRY_KIND_LABELS, formatMoney, isLateDate, lateEntryCutoff,
  type LateEntry, type LateEntryCopy, type LateEntryEarlier, type LateEntryKind, type LateEntryMe, type LateEntryQuery,
} from "@delta/shared";
import { env } from "../../config/env";
import { AppError } from "../../lib/http";
import { logger } from "../../lib/logger";
import { sendNotice } from "../../lib/email";
import { Organization } from "../organization/organization.model";
import { User } from "../user/user.model";
import { LateEntryModel, type RecordLate } from "./late-entry.model";

/*
 * Late entries (the user, 2026-10-17: "when any old expense is entered a request goes to the managers … only
 * Manager-tagged users see the page, only they approve or reject … and a reason has to be entered").
 *
 * An expense, a bill, a payment on a bill, a payment on an invoice or a bank / cash line (2026-10-21) typed in (or
 * edited) with a date `lateEntryDays` or more days back (1 unless set: anything before today) needs a reason, and
 * waits for a manager:
 *   - while it waits: an expense can't be approved or marked paid, a bill can't be approved or paid, and a payment
 *     stays out of its bank account;
 *   - approved: it carries on as any other;
 *   - rejected (with a reason): an edit that moved the date back has its date put back; a new expense is rejected, a
 *     new bill voided, a new payment removed. It sticks (2026-10-22): the record is not asked again with another old
 *     date, only given one that is not late — which clears it.
 * A manager is somebody tagged Manager in this organization; a super admin decides too, so nothing is stuck when
 * nobody is tagged. Nobody decides their own. Only the screens people type into ask (their controllers pass who is
 * typing): approvals, HRMS, payroll and CS Portal make entries that are not asked.
 */

const oid = (v: unknown) => new Types.ObjectId(String(v));
const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

/** Who is typing it in, and why late — from the request. */
export interface LateActor {
  userId: string;
  reason?: string;
}

/** A request about to be opened: the record's own view of it is set before saving, the entry made after. */
export interface LatePending {
  entryId: Types.ObjectId;
  reason: string;
  date: Date;
  previousDate: Date | null;
  enteredById: string;
  enteredByName: string;
  sub: RecordLate;
}

export async function lateEntryDaysOf(orgId: string): Promise<number> {
  const org = await Organization.findById(orgId).select("lateEntryDays").lean<any>();
  const days = org?.lateEntryDays;
  return typeof days === "number" && days >= 0 ? days : DEFAULT_LATE_ENTRY_DAYS;
}

async function nameOf(userId: string): Promise<string> {
  if (!Types.ObjectId.isValid(userId)) return "";
  return (await User.findById(userId).select("name").lean<any>())?.name ?? "";
}

/**
 * A record's date set or changed by somebody typing: what its late entry becomes. `next` is undefined when it stays
 * as it was, null when it goes (an edit moved a waiting one back within the days), else the new one; `pending` is the
 * request to open after saving; `withdraw` says a waiting one is no longer asked. Throws when it is late and no
 * reason was given.
 */
export async function lateForDate(
  orgId: string, actor: LateActor | undefined, date: Date | string | null | undefined, before: Date | string | null | undefined,
  current: RecordLate | null | undefined,
): Promise<{ next: RecordLate | null | undefined; pending: LatePending | null; withdraw: boolean }> {
  const same = { next: undefined, pending: null, withdraw: false };
  if (!actor || !date) return same;
  if (before && day(before) === day(date)) return same;
  const days = await lateEntryDaysOf(orgId);
  if (!isLateDate(new Date(date), days)) {
    // Back within the days: a waiting one is no longer asked, and a rejected one no longer stands in its way — an
    // expense rejected for its old date can be sent again once it carries a date that is not late (2026-10-22).
    if (current?.state === "pending") return { next: null, pending: null, withdraw: true };
    return current?.state === "rejected" ? { next: null, pending: null, withdraw: false } : same;
  }
  // A manager said no: the same record is not asked again with another old date (the user, 2026-10-22: "the late
  // entry is showing the rejected, then approved is showing again").
  if (current?.state === "rejected") {
    const who = current.decidedByName || "A manager";
    const note = current.decisionNote ? ` ("${current.decisionNote}")` : "";
    throw new AppError("CONFLICT", `${who} rejected this being entered late${note} — it can't be asked again. Give it a date from ${lateEntryCutoff(days)} on, or leave its date as it is`);
  }
  const reason = String(actor.reason ?? "").trim();
  if (!reason) {
    const rule = days === 1 ? "before today" : `${days} or more days back`;
    throw new AppError("VALIDATION_ERROR", `This is dated ${day(date)}, ${rule} — give the reason it is entered late; a manager will need to approve it`);
  }
  const entryId = new Types.ObjectId();
  const enteredByName = await nameOf(actor.userId);
  // Moved again while it waits: what it had before that request is what a rejection goes back to (none, for a new one).
  const prior = current?.state === "pending" ? await LateEntryModel.findById(current.entryId).select("previousDate").lean<any>() : null;
  const previousDate = prior ? prior.previousDate ?? null : before ? new Date(before) : null;
  const sub: RecordLate = { state: "pending", entryId, reason, enteredByName };
  return {
    next: sub,
    pending: { entryId, reason, date: new Date(date), previousDate, enteredById: actor.userId, enteredByName, sub },
    withdraw: current?.state === "pending",
  };
}

/** After saving: the request itself — any earlier one for the same record no longer asked — and the managers told. */
export async function openLateEntry(
  orgId: string, pending: LatePending,
  info: { kind: LateEntryKind; refId: unknown; paymentId?: unknown; accountId?: unknown; number: string; title: string; amountMinor: number; currency: string },
): Promise<void> {
  await withdrawLateFor(orgId, info.kind, info.refId, info.paymentId);
  const entry = await LateEntryModel.create({
    _id: pending.entryId, organizationId: oid(orgId), kind: info.kind, refId: oid(info.refId),
    paymentId: info.paymentId ? oid(info.paymentId) : null, accountId: info.accountId ? oid(info.accountId) : null,
    number: info.number, title: info.title.slice(0, 200),
    amountMinor: info.amountMinor, currency: info.currency, date: pending.date, previousDate: pending.previousDate,
    reason: pending.reason, enteredById: oid(pending.enteredById), enteredByName: pending.enteredByName,
  });
  void notifyManagers(orgId, entry.toObject());
}

/** Whatever is still waiting for this record is no longer asked — it was deleted, voided, or moved back in time. */
export async function withdrawLateFor(orgId: string, kind: LateEntryKind, refId: unknown, paymentId?: unknown): Promise<void> {
  await LateEntryModel.updateMany(
    { organizationId: oid(orgId), kind, refId: oid(refId), ...(paymentId ? { paymentId: oid(paymentId) } : {}), state: "pending" },
    { $set: { state: "withdrawn", decidedAt: new Date() } },
  );
}

/** Tagged Manager in this organization, or a super admin. */
export async function isManager(orgId: string, userId: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(userId)) return false;
  const u = await User.findOne({ _id: oid(userId), status: "active" }).select("isSuperAdmin memberships").lean<any>();
  if (!u) return false;
  if (u.isSuperAdmin) return true;
  const m = (u.memberships ?? []).find((x: any) => String(x.organizationId) === String(orgId));
  return Boolean(m?.isManager && m.status === "active");
}

async function requireManager(orgId: string, userId: string): Promise<void> {
  if (!(await isManager(orgId, userId))) throw new AppError("FORBIDDEN", "Only somebody tagged Manager decides late entries");
}

const hrefOf = (e: any): string =>
  e.kind === "expense" ? `/expenses/${e.refId}` : e.kind === "invoice_payment" ? `/invoices/${e.refId}`
    : e.kind === "bank_line" ? (e.accountId ? `/banking/${e.accountId}` : "/banking") : `/bills/${e.refId}`;

function toDTO(e: any, userId: string, manager: boolean): LateEntry {
  return {
    id: String(e._id), kind: e.kind, refId: String(e.refId), ...(e.paymentId ? { paymentId: String(e.paymentId) } : {}),
    number: e.number ?? "", title: e.title ?? "", amountMinor: e.amountMinor ?? 0, currency: e.currency ?? "AED",
    date: day(e.date), ...(e.previousDate ? { previousDate: day(e.previousDate) } : {}),
    reason: e.reason ?? "", state: e.state, enteredById: String(e.enteredById), enteredByName: e.enteredByName ?? "",
    enteredAt: new Date(e.createdAt).toISOString(),
    ...(e.decidedByName ? { decidedByName: e.decidedByName } : {}),
    ...(e.decidedAt ? { decidedAt: new Date(e.decidedAt).toISOString() } : {}),
    ...(e.decisionNote ? { decisionNote: e.decisionNote } : {}),
    href: hrefOf(e),
    canDecide: manager && e.state === "pending" && String(e.enteredById) !== String(userId),
  };
}

// ── One card per record; what looks like the same money twice (the user, 2026-10-22) ─────────────────────────────

const recordKey = (e: any) => `${e.kind}|${e.refId}|${e.paymentId ?? ""}`;

/** The record's other requests — asked before, moved again — shown on its one card, newest first. */
function earlierOf(e: any): LateEntryEarlier {
  return {
    id: String(e._id), state: e.state, date: day(e.date), ...(e.previousDate ? { previousDate: day(e.previousDate) } : {}),
    reason: e.reason ?? "", enteredByName: e.enteredByName ?? "", enteredAt: new Date(e.createdAt).toISOString(),
    ...(e.decidedByName ? { decidedByName: e.decidedByName } : {}),
    ...(e.decidedAt ? { decidedAt: new Date(e.decidedAt).toISOString() } : {}),
    ...(e.decisionNote ? { decisionNote: e.decisionNote } : {}),
  };
}

/**
 * Another record asked about the same money: the same amount (either way round — an expense and the cash line typed
 * for it), currency and date. A bill and a payment on it share a number but are not copies; two payments on one
 * invoice or bill are, when they match.
 */
function isCopy(a: any, b: any): boolean {
  if (String(a._id) === String(b._id) || recordKey(a) === recordKey(b)) return false;
  if (String(a.refId) === String(b.refId) && a.kind !== b.kind) return false;
  const amount = Math.abs(a.amountMinor ?? 0);
  return amount > 0 && amount === Math.abs(b.amountMinor ?? 0) && (a.currency ?? "AED") === (b.currency ?? "AED") && day(a.date) === day(b.date);
}

function copyOf(e: any): LateEntryCopy {
  return {
    id: String(e._id), kind: e.kind, number: e.number ?? "", title: e.title ?? "", state: e.state, date: day(e.date), href: hrefOf(e),
    ...(e.decidedByName ? { decidedByName: e.decidedByName } : {}),
  };
}

/**
 * The page's cards: each record once — its newest request (waiting before decided), the others under it — and, for
 * all but the ones no longer asked, the other records that look like the same money typed twice.
 */
async function cardsOf(base: Record<string, unknown>, rows: any[], userId: string, manager: boolean): Promise<LateEntry[]> {
  const first = new Map<string, any>();
  for (const e of rows) if (!first.has(recordKey(e))) first.set(recordKey(e), e);
  const shown = [...first.values()];
  if (!shown.length) return [];
  const [related, alike] = await Promise.all([
    LateEntryModel.find({ ...base, refId: { $in: shown.map((e) => e.refId) } }).sort({ createdAt: -1 }).lean<any[]>(),
    LateEntryModel.find({
      ...base, state: { $in: ["pending", "approved", "rejected"] },
      amountMinor: { $in: [...new Set(shown.flatMap((e) => [Math.abs(e.amountMinor ?? 0), -Math.abs(e.amountMinor ?? 0)]))] },
    }).sort({ createdAt: -1 }).limit(2000).lean<any[]>(),
  ]);
  return shown.map((e) => {
    const earlier = related.filter((x) => recordKey(x) === recordKey(e) && String(x._id) !== String(e._id)).slice(0, 10);
    const copies = e.state === "withdrawn" ? [] : alike.filter((x) => isCopy(e, x)).slice(0, 5);
    return {
      ...toDTO(e, userId, manager),
      ...(earlier.length ? { earlier: earlier.map(earlierOf) } : {}),
      ...(copies.length ? { possibleCopies: copies.map(copyOf) } : {}),
    };
  });
}

// ── The records themselves ────────────────────────────────────────────────────────────────────────────────────

/** The record's own view of its late entry, as it is now — null when the record (or the payment) has gone. */
async function recordLateOf(e: any): Promise<RecordLate | null> {
  const [{ Expense }, { Bill }, { Invoice }] = await Promise.all([
    import("../expense/expense.model"), import("../bill/bill.model"), import("../invoice/invoice.model"),
  ]);
  if (e.kind === "expense") return (await Expense.findOne({ _id: e.refId, organizationId: e.organizationId }).select("lateEntry").lean<any>())?.lateEntry ?? null;
  if (e.kind === "bill") return (await Bill.findOne({ _id: e.refId, organizationId: e.organizationId }).select("lateEntry").lean<any>())?.lateEntry ?? null;
  if (e.kind === "bank_line") {
    const { BankTransaction } = await import("../banking/bank-transaction.model");
    return (await BankTransaction.findOne({ _id: e.refId, organizationId: e.organizationId }).select("lateEntry").lean<any>())?.lateEntry ?? null;
  }
  const Model: any = e.kind === "bill_payment" ? Bill : Invoice;
  const doc = await Model.findOne({ _id: e.refId, organizationId: e.organizationId }).select("payments._id payments.lateEntry").lean();
  return (doc?.payments ?? []).find((p: any) => String(p._id) === String(e.paymentId))?.lateEntry ?? null;
}

/** Still asked: the record is there and is waiting on this very request. */
async function stillAsked(e: any): Promise<boolean> {
  const l = await recordLateOf(e);
  return l?.state === "pending" && String(l.entryId) === String(e._id);
}

/** The record's own view updated with the decision. */
function decidedSub(e: any, state: "approved" | "rejected", by: string, note: string): RecordLate {
  return { state, entryId: e._id, reason: e.reason, enteredByName: e.enteredByName, decidedByName: by, decisionNote: note };
}

async function apply(orgId: string, e: any, decision: "approved" | "rejected", by: { id: string; name: string }, note: string): Promise<void> {
  const sub = decidedSub(e, decision, by.name, note);
  const orgOid = oid(orgId);
  if (e.kind === "expense") {
    const { Expense } = await import("../expense/expense.model");
    const { syncExpenseLine } = await import("../expense/expense.service");
    const set: Record<string, unknown> = { lateEntry: sub };
    if (decision === "rejected") {
      if (e.previousDate) set.expenseDate = e.previousDate;
      else Object.assign(set, { status: "rejected", rejectedReason: `Entered late — rejected by ${by.name}: ${note}`.slice(0, 500) });
    }
    await Expense.updateOne({ _id: e.refId, organizationId: orgOid }, { $set: set });
    await syncExpenseLine(orgId, e.refId);
    return;
  }
  if (e.kind === "bill") {
    const { Bill } = await import("../bill/bill.model");
    const set: Record<string, unknown> = { lateEntry: sub };
    if (decision === "rejected") {
      if (e.previousDate) set.billDate = e.previousDate;
      else set.status = "voided";
    }
    await Bill.updateOne({ _id: e.refId, organizationId: orgOid }, { $set: set });
    // Its expense follows: its date back, or voided with it (2026-10-23).
    await (await import("../bill/bill-expense")).syncBillExpense(orgId, e.refId);
    return;
  }
  if (e.kind === "bank_line") {
    // Approved: the line stands. Rejected: a new one goes; one moved back gets its date back. Its account's balances follow.
    const { BankTransaction } = await import("../banking/bank-transaction.model");
    const { recalculateRunningBalances } = await import("../banking/banking.service");
    const line = await BankTransaction.findOne({ _id: e.refId, organizationId: orgOid }).select("accountId transfer").lean<any>();
    if (!line) return;
    // One side of a transfer (2026-10-22): the other side is decided with it — both stand, both go, or both get
    // their date back.
    const pair = line.transfer?.otherTransactionId
      ? await BankTransaction.findOne({ _id: line.transfer.otherTransactionId, organizationId: orgOid }).select("accountId").lean<any>()
      : null;
    const ids = [e.refId, ...(pair ? [pair._id] : [])];
    if (decision === "rejected" && !e.previousDate) await BankTransaction.deleteMany({ _id: { $in: ids }, organizationId: orgOid });
    else await BankTransaction.updateMany({ _id: { $in: ids }, organizationId: orgOid }, { $set: { lateEntry: sub, ...(decision === "rejected" ? { date: e.previousDate } : {}) } });
    await recalculateRunningBalances(orgId, line.accountId);
    if (pair) await recalculateRunningBalances(orgId, pair.accountId);
    return;
  }
  if (e.kind === "bill_payment") {
    const { Bill } = await import("../bill/bill.model");
    const bills = await import("../bill/bill.service");
    await Bill.updateOne({ _id: e.refId, organizationId: orgOid, "payments._id": e.paymentId }, {
      $set: { "payments.$.lateEntry": sub, ...(decision === "rejected" && e.previousDate ? { "payments.$.paidOn": e.previousDate } : {}) },
    });
    if (decision === "rejected" && !e.previousDate) await bills.deleteBillPayment(orgId, String(e.refId), String(e.paymentId));
    else {
      await bills.resyncBillPaymentLine(orgId, String(e.refId), String(e.paymentId));
      await (await import("../bill/bill-expense")).syncBillExpense(orgId, e.refId);
    }
    return;
  }
  // An invoice payment.
  const { Invoice } = await import("../invoice/invoice.model");
  const { syncPaymentLine } = await import("../invoice/payment-bank");
  if (decision === "rejected" && !e.previousDate) {
    await Invoice.updateOne({ _id: e.refId, organizationId: orgOid, "payments._id": e.paymentId }, { $set: { "payments.$.lateEntry": sub } });
    const { deletePayment } = await import("../invoice/invoice.service");
    await deletePayment(orgId, String(e.refId), String(e.paymentId));
    // What was received changed, as when a payment is deleted by hand.
    const { autoCalculate } = await import("../commission/commission.service");
    void autoCalculate(orgId, String(e.refId), "payment_received").catch(() => undefined);
    return;
  }
  const doc = await Invoice.findOne({ _id: e.refId, organizationId: orgOid });
  const p = (doc?.payments as unknown as { id: (x: string) => any } | undefined)?.id(String(e.paymentId));
  if (!doc || !p) return;
  p.set("lateEntry", sub);
  if (decision === "rejected" && e.previousDate) {
    p.set("paidOn", e.previousDate);
    // The next instalment is due 29 days after the latest payment — which this may have been.
    const { applyInstalmentDue } = await import("../invoice/instalments");
    applyInstalmentDue(doc as never);
  }
  await doc.save();
  await syncPaymentLine(doc as never, e.paymentId);
}

// ── The page ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Who reads the page: managers only — tagged Manager here, or a super admin (the user, 2026-10-22: "late entries
 * only show for the managers"). From 2026-10-20 whoever saw expenses or bills read every one too, and whoever only
 * had their own expenses their own; everybody else now sees a late entry on the record itself. Only managers decide.
 */
type LateScope = "all" | "none";
const scopeOf = (manager: boolean): LateScope => (manager ? "all" : "none");

/** The names of whoever decides: the people tagged Manager, or with none tagged the super admins. */
async function managerNames(orgId: string): Promise<string[]> {
  const tagged = await User.find({
    status: "active",
    memberships: { $elemMatch: { organizationId: oid(orgId), isManager: true, status: "active" } },
  }).select("name").lean<any[]>();
  const people = tagged.length ? tagged : await User.find({ status: "active", isSuperAdmin: true }).select("name").lean<any[]>();
  return people.map((u) => String(u.name ?? "")).filter(Boolean).sort();
}

export async function lateEntryMe(orgId: string, userId: string): Promise<LateEntryMe> {
  const [manager, days, managers] = await Promise.all([isManager(orgId, userId), lateEntryDaysOf(orgId), managerNames(orgId)]);
  const scope = scopeOf(manager);
  const pending = scope === "none" ? 0 : await LateEntryModel.countDocuments({ organizationId: oid(orgId), state: "pending" });
  return { isManager: manager, pending, days, canView: scope !== "none", scope, managers };
}

export async function listLateEntries(orgId: string, userId: string, q: LateEntryQuery): Promise<LateEntry[]> {
  const manager = await isManager(orgId, userId);
  if (scopeOf(manager) === "none") throw new AppError("FORBIDDEN", "Late entries are for managers — people tagged Manager, or a super admin");
  const base = { organizationId: oid(orgId) };

  const waiting = async () => {
    const rows = await LateEntryModel.find({ ...base, state: "pending" }).sort({ createdAt: 1 }).limit(500).lean<any[]>();
    const live: any[] = [];
    for (const e of rows) {
      // The record went, or was moved on without this request: nothing left to decide.
      if (await stillAsked(e)) live.push(e);
      else await LateEntryModel.updateOne({ _id: e._id, state: "pending" }, { $set: { state: "withdrawn", decidedAt: new Date() } });
    }
    return live;
  };
  const decided = () => LateEntryModel.find({ ...base, state: { $in: ["approved", "rejected", "withdrawn"] } })
    .sort({ decidedAt: -1, updatedAt: -1 }).limit(200).lean<any[]>();

  const rows = q.state === "pending" ? await waiting() : q.state === "decided" ? await decided() : [...(await waiting()), ...(await decided())];
  return cardsOf(base, rows, userId, manager);
}

export async function decideLateEntry(
  orgId: string, userId: string, id: string, decision: "approved" | "rejected", noteIn: string,
): Promise<LateEntry> {
  await requireManager(orgId, userId);
  if (!Types.ObjectId.isValid(id)) throw new AppError("NOT_FOUND", "Late entry not found");
  const e = await LateEntryModel.findOne({ _id: oid(id), organizationId: oid(orgId) }).lean<any>();
  if (!e) throw new AppError("NOT_FOUND", "Late entry not found");
  if (e.state !== "pending") throw new AppError("CONFLICT", `It was ${e.state} already`);
  if (String(e.enteredById) === String(userId)) throw new AppError("CONFLICT", "Somebody else decides your own late entry");
  const note = String(noteIn ?? "").trim();
  if (decision === "rejected" && !note) throw new AppError("VALIDATION_ERROR", "Say why it is rejected");
  if (!(await stillAsked(e))) {
    await LateEntryModel.updateOne({ _id: e._id }, { $set: { state: "withdrawn", decidedAt: new Date() } });
    throw new AppError("CONFLICT", "It has been changed or removed since — there is nothing left to decide");
  }
  // Claimed first, so two managers pressing at once do not both act.
  const by = { id: userId, name: (await nameOf(userId)) || "A manager" };
  const claimed = await LateEntryModel.findOneAndUpdate(
    { _id: e._id, state: "pending" },
    { $set: { state: decision, decidedById: oid(userId), decidedByName: by.name, decidedAt: new Date(), decisionNote: note } },
    { new: true },
  ).lean<any>();
  if (!claimed) throw new AppError("CONFLICT", "Another manager has just decided it");
  try {
    await apply(orgId, claimed, decision, by, note);
  } catch (err) {
    // Not done after all: back to waiting, so it can be decided again.
    await LateEntryModel.updateOne({ _id: e._id }, { $set: { state: "pending", decidedById: null, decidedByName: "", decidedAt: null, decisionNote: "" } });
    throw err;
  }
  void notifyEnterer(orgId, claimed);
  return toDTO(claimed, userId, true);
}

// ── Who is told ───────────────────────────────────────────────────────────────────────────────────────────────

/** The managers of this organization — or, with none tagged, the super admins — less whoever typed it. */
async function managerEmails(orgId: string, except: string): Promise<string[]> {
  const tagged = await User.find({
    status: "active",
    memberships: { $elemMatch: { organizationId: oid(orgId), isManager: true, status: "active" } },
  }).select("email").lean<any[]>();
  const people = tagged.length ? tagged : await User.find({ status: "active", isSuperAdmin: true }).select("email").lean<any[]>();
  return people.filter((u) => String(u._id) !== String(except) && u.email).map((u) => String(u.email));
}

async function notifyManagers(orgId: string, e: any): Promise<void> {
  try {
    const to = await managerEmails(orgId, e.enteredById);
    if (!to.length) return;
    const what = LATE_ENTRY_KIND_LABELS[e.kind as LateEntryKind];
    await sendNotice({
      log: { organizationId: orgId, kind: "late_entry", ref: { type: e.kind, id: String(e.refId), label: e.number } },
      to,
      subject: `Late entry to approve: ${what.toLowerCase()} ${e.number} dated ${day(e.date)}`,
      title: `${e.enteredByName || "Somebody"} entered a ${what.toLowerCase()} dated ${day(e.date)}`,
      lines: [
        `${e.number}${e.title ? ` · ${e.title}` : ""} — ${formatMoney(e.amountMinor ?? 0, e.currency ?? "AED")}`,
        e.previousDate ? `Its date was moved back from ${day(e.previousDate)}.` : "",
        `Why it is late: ${e.reason}`,
      ].filter(Boolean),
      actionLabel: "Open late entries",
      actionUrl: `${env.WEB_ORIGIN}/late-entries`,
    });
  } catch (err) {
    logger.error({ err, lateEntryId: String(e._id) }, "Could not tell the managers about a late entry");
  }
}

async function notifyEnterer(orgId: string, e: any): Promise<void> {
  try {
    const u = await User.findById(e.enteredById).select("email status").lean<any>();
    if (!u?.email || u.status !== "active") return;
    const what = LATE_ENTRY_KIND_LABELS[e.kind as LateEntryKind];
    const approved = e.state === "approved";
    await sendNotice({
      log: { organizationId: orgId, kind: "late_entry", ref: { type: e.kind, id: String(e.refId), label: e.number } },
      to: [u.email],
      subject: `Late ${what.toLowerCase()} ${e.number} ${approved ? "approved" : "rejected"}`,
      title: `${e.decidedByName} ${approved ? "approved" : "rejected"} your late ${what.toLowerCase()}`,
      lines: [
        `${e.number}${e.title ? ` · ${e.title}` : ""} — ${formatMoney(e.amountMinor ?? 0, e.currency ?? "AED")}, dated ${day(e.date)}`,
        e.decisionNote ? `${approved ? "Note" : "Why"}: ${e.decisionNote}` : "",
        approved ? "" : e.previousDate ? `Its date is back to ${day(e.previousDate)}.`
          : e.kind === "expense" ? "The expense is rejected." : e.kind === "bill" ? "The bill is voided." : e.kind === "bank_line" ? "The line has been removed." : "The payment has been removed.",
      ].filter(Boolean),
      actionLabel: "Open it",
      actionUrl: `${env.WEB_ORIGIN}${hrefOf(e)}`,
    });
  } catch (err) {
    logger.error({ err, lateEntryId: String(e._id) }, "Could not tell who entered it about the decision");
  }
}

// ── Old dates: everything entered with a date of its own before the day it was typed (2026-10-21) ──────────────────

/**
 * The organizations whose old-date entries this person reads (2026-10-21, "show all organizations"): a super admin,
 * every one; anybody else, each organization they are an active member of and tagged Manager in (managers only since
 * 2026-10-22).
 */
async function oldDateOrgs(userId: string): Promise<{ _id: Types.ObjectId; name: string }[]> {
  if (!Types.ObjectId.isValid(userId)) return [];
  const u = await User.findOne({ _id: oid(userId), status: "active" }).select("isSuperAdmin memberships").lean<any>();
  if (!u) return [];
  if (u.isSuperAdmin) return Organization.find().select("name").sort({ name: 1 }).lean<any[]>();
  const ids = ((u.memberships ?? []) as any[]).filter((m) => m.status === "active" && m.isManager).map((m) => m.organizationId);
  return Organization.find({ _id: { $in: ids } }).select("name").sort({ name: 1 }).lean<any[]>();
}

/**
 * The finance side of Root's Pending → Finance "Entered with an old date" (the user, 2026-10-21: "finance is not
 * showing them — show that", then "show all organizations"): every organization this person reads (oldDateOrgs) —
 * the last 30 days' entries dated a day or more before they were typed in — typed in finance, recorded by an
 * approval, or brought from HRMS — each with its organization and its late entry, if any. For the managers, as the
 * late entries are (2026-10-22).
 */
export async function oldDateEntries(orgId: string, userId: string) {
  const manager = await isManager(orgId, userId);
  if (scopeOf(manager) !== "all") throw new AppError("FORBIDDEN", "Entries with an old date are for managers — people tagged Manager, or a super admin");
  const { backdatedIn, BACKDATE_MIN_DAYS, ENTERED_WITHIN_DAYS } = await import("../integrations/portal-watch.service");
  const orgs = await oldDateOrgs(userId);
  const since = new Date(Date.now() - ENTERED_WITHIN_DAYS * 86_400_000);
  const rows = (await Promise.all(orgs.map((o) => backdatedIn({ _id: o._id, name: o.name }, since)))).flat()
    .sort((a, b) => b.enteredAt.localeCompare(a.enteredAt));
  const count = (o: string) => rows.filter((r) => r.origin === o).length;
  return {
    rules: { minDays: BACKDATE_MIN_DAYS, withinDays: ENTERED_WITHIN_DAYS, lateEntryDays: await lateEntryDaysOf(orgId) },
    currentOrgId: orgId,
    organizations: orgs.map((o) => ({ id: String(o._id), name: o.name, count: rows.filter((r) => r.orgId === String(o._id)).length })),
    counts: { typed: count("typed"), approval: count("approval"), hrms: count("hrms"), all: rows.length },
    rows,
  };
}

