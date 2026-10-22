import { Types } from "mongoose";
import type {
  CreateExpenseInput,
  UpdateExpenseInput,
  Expense as ExpenseDTO,
  ExpenseQuery,
  ExpenseSummary,
  ExpenseSummaryCurrency,
  Paginated,
  RejectExpenseInput,
  ExpensePaymentStatus,
  MarkExpensePaidInput,
  ExpenseAttachmentInput,
  UploadedExpenseFile,
} from "@delta/shared";
import { EXPENSE_CATEGORY_LABELS, computeExpenseTax, lateEntryCutoff, resolveCategoryName } from "@delta/shared";
import { throughDay } from "../../lib/day-range";
import { AppError } from "../../lib/http";
import { assertOwned, scopeFilter, type Scope } from "../../lib/ownership";
import type { ParsedFile } from "../../middleware/upload";
import {
  notifyApproversOfSubmission,
  notifyExpenseApproved,
  notifyExpenseRejected,
} from "./expense-notify.service";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { Expense, type ExpenseDoc } from "./expense.model";
import { User } from "../user/user.model";
import { nextNumber } from "../sequence/sequence.service";
import { resolveExpenseCategory } from "../expense-category/expense-category.service";
import { assertDebitMovable, debitAccount, syncDebitLine } from "../banking/money-out";
import { paymentAccountsOf } from "../invoice/payment-bank";
import { lateView, isLatePending } from "../late-entry/late-entry.model";
import { lateEntryDaysOf, lateForDate, openLateEntry, withdrawLateFor, type LateActor } from "../late-entry/late-entry.service";

/** Resolve a category's display name: denormalized value, then default label, then a humanized slug. */
function categoryDisplay(slug: string, denorm?: string): string {
  if (denorm && denorm.trim()) return denorm;
  const label = (EXPENSE_CATEGORY_LABELS as Record<string, string>)[slug];
  if (label) return label;
  return slug.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Maps a (possibly populated) departmentId to the DTO ref. */
function toDepartmentRef(raw: unknown): { id: string; name: string } | null {
  if (!raw) return null;
  const d = raw as { _id?: Types.ObjectId; name?: string };
  if (d._id && typeof d.name === "string") return { id: d._id.toString(), name: d.name };
  return null;
}

/** A salesperson has to be somebody in this organization — their name kept with the expense. */
async function requireOrgSalesperson(orgId: string, userId: string): Promise<{ id: Types.ObjectId; name: string }> {
  const u = await User.findOne({ _id: userId, memberships: { $elemMatch: { organizationId: new Types.ObjectId(orgId), status: "active" } } })
    .select("name").lean<{ _id: Types.ObjectId; name?: string } | null>();
  if (!u) throw new AppError("VALIDATION_ERROR", "Invalid salesperson selected");
  return { id: u._id, name: u.name ?? "" };
}

/** A department has to belong to this organization, or it is not one. */
async function requireOrgDepartment(orgId: string, departmentId: string) {
  const { Department } = await import("../department/department.model");
  const dept = await Department.findOne({ _id: departmentId, organizationId: orgId });
  if (!dept) throw new AppError("VALIDATION_ERROR", "Invalid department selected");
  return dept;
}

function dateOnly(d: Date | undefined): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

/**
 * Whether the money has gone out, and whether it is late.
 *
 * Derived rather than stored, because "overdue" is a fact about today: a copy
 * written into the document would be right on the day it was written and wrong
 * the next morning. The same reasoning as an invoice's effective status.
 *
 * A claim with no due date is never late. That is the point of leaving it
 * blank — an expense nobody set a deadline for has not missed one.
 */
function paymentStatus(paidOn: Date | undefined, dueDate: Date | undefined): ExpensePaymentStatus {
  if (paidOn) return "paid";
  if (!dueDate) return "unpaid";
  // Compared by day, not by instant, so a claim due today is not overdue at one
  // minute past midnight.
  return dateOnly(dueDate) < new Date().toISOString().slice(0, 10) ? "overdue" : "unpaid";
}

function toDTO(doc: ExpenseDoc): ExpenseDTO {
  const d = doc as unknown as Record<string, unknown>;
  const rec = d.recurrence as { frequency: string; nextDate: Date; endDate?: Date; isActive?: boolean } | undefined;
  const mil = d.mileage as { distanceKm: number; ratePerKmMinor: number; totalMinor: number } | undefined;
  const atts =
    (d.attachments as {
      name: string;
      url: string;
      key?: string;
      size?: number;
      mimeType?: string;
      uploadedAt?: Date;
    }[]) ?? [];

  return {
    id: doc._id.toString(),
    expenseNumber: doc.expenseNumber,
    category: doc.category as string,
    categoryName: categoryDisplay(doc.category as string, d.categoryName as string | undefined),
    ...(d.subcategory ? { subcategory: d.subcategory as string, subcategoryName: (d.subcategoryName as string) || (d.subcategory as string) } : {}),
    ...((d.legacyCategory as { name?: string } | undefined)?.name ? { legacyCategoryName: (d.legacyCategory as { name: string }).name } : {}),
    description: doc.description,
    expenseDate: dateOnly(doc.expenseDate as unknown as Date),
    amountMinor: (doc.amountMinor as number) ?? 0,
    taxPct: (doc.taxPct as number) ?? 0,
    taxInclusive: (doc.taxInclusive as boolean) ?? false,
    taxMinor: (doc.taxMinor as number) ?? 0,
    totalMinor: (doc.totalMinor as number) ?? 0,
    currency: (doc.currency as string) ?? "AED",
    paymentAccount: (doc.paymentAccount as string) ?? "",
    bankAccountId: d.bankAccountId ? String(d.bankAccountId) : undefined,
    inBank: d.bankAccountId ? Boolean(d.bankTransactionId) : undefined,
    bankNote: (d.bankNote as string) || undefined,
    lateEntry: lateView(d.lateEntry),
    paymentMethod: (d.paymentMethod as ExpenseDTO["paymentMethod"]) ?? undefined,
    reference: (doc.reference as string) ?? "",
    submittedById: String(doc.submittedById),
    submittedByName: doc.submittedByName,
    status: doc.status as ExpenseDTO["status"],
    dueDate: d.dueDate ? dateOnly(d.dueDate as Date) : undefined,
    paidOn: d.paidOn ? dateOnly(d.paidOn as Date) : undefined,
    paymentStatus: paymentStatus(d.paidOn as Date | undefined, d.dueDate as Date | undefined),
    approvedById: d.approvedById ? String(d.approvedById) : undefined,
    approvedByName: (d.approvedByName as string) ?? undefined,
    approvedAt: d.approvedAt ? (d.approvedAt as Date).toISOString() : undefined,
    rejectedReason: (d.rejectedReason as string) ?? undefined,
    isRecurring: (doc.isRecurring as boolean) ?? false,
    recurrence: rec
      ? {
          frequency: rec.frequency as NonNullable<ExpenseDTO["recurrence"]>["frequency"],
          nextDate: dateOnly(rec.nextDate),
          endDate: rec.endDate ? dateOnly(rec.endDate) : undefined,
          isActive: rec.isActive ?? true,
        }
      : undefined,
    parentExpenseId: d.parentExpenseId ? String(d.parentExpenseId) : undefined,
    mileage: mil
      ? { distanceKm: mil.distanceKm, ratePerKmMinor: mil.ratePerKmMinor, totalMinor: mil.totalMinor }
      : undefined,
    attachments: atts.map((a) => ({
      name: a.name,
      url: a.url,
      key: a.key ?? undefined,
      size: a.size ?? undefined,
      mimeType: a.mimeType ?? undefined,
      uploadedAt: a.uploadedAt ? new Date(a.uploadedAt).toISOString() : undefined,
    })),
    projectName: (doc.projectName as string) ?? "",
    department: toDepartmentRef((doc as unknown as { departmentId?: unknown }).departmentId),
    salesperson: d.salespersonId ? { id: String(d.salespersonId), name: String(d.salespersonName ?? "") } : null,
    costCentre: (doc.costCentre as string) ?? "",
    notes: (doc.notes as string) ?? "",
    createdAt: doc.createdAt.toISOString(),
  };
}

const SORT = {
  number: "expenseNumber",
  description: "description",
  category: "category",
  date: "expenseDate",
  status: "status",
  total: "totalMinor",
  submittedBy: "submittedByName",
  createdAt: "createdAt",
} as const;

/**
 * What the Expenses list's filters match — the table, its export and its cards (2026-10-21) read the same
 * filter, so they cannot disagree.
 */
function expenseListFilter(orgId: string, query: ExpenseQuery, scope: Scope): Record<string, unknown> {
  const and: Record<string, unknown>[] = [];
  // Notes too: an imported row's "[Needs review]", its old account, its accountant's note (2026-10-21).
  const or = searchOr(query.q, ["expenseNumber", "description", "submittedByName", "notes"]);
  if (or) and.push({ $or: or });
  if (query.status) and.push({ status: query.status });
  if (query.category) and.push({ category: query.category });
  if (query.subcategory) and.push({ subcategory: query.subcategory });
  if (query.submittedById) and.push({ submittedById: new Types.ObjectId(query.submittedById) });
  if (query.dateFrom) and.push({ expenseDate: { $gte: new Date(query.dateFrom) } });
  if (query.dateTo) and.push({ expenseDate: throughDay(query.dateTo) });
  if (query.projectName) and.push({ projectName: { $regex: query.projectName, $options: "i" } });
  if (query.costCentre) and.push({ costCentre: { $regex: query.costCentre, $options: "i" } });
  if (query.departmentId) and.push({ departmentId: new Types.ObjectId(query.departmentId) });
  if (query.salespersonId) and.push({ salespersonId: new Types.ObjectId(query.salespersonId) });
  if (query.isRecurring !== undefined) and.push({ isRecurring: query.isRecurring });

  // The derived status, expressed as the query that produces it, so filtering
  // and the badge on the row cannot disagree. The three are exclusive: unpaid
  // means not paid and not yet late, which is what the badge says.
  if (query.paymentStatus) {
    const todayStart = new Date(new Date().toISOString().slice(0, 10));
    if (query.paymentStatus === "paid") and.push({ paidOn: { $ne: null } });
    else if (query.paymentStatus === "overdue")
      and.push({ paidOn: null, dueDate: { $ne: null, $lt: todayStart } });
    else and.push({ paidOn: null, $or: [{ dueDate: null }, { dueDate: { $gte: todayStart } }] });
  }

  // Applied after the caller's own filters, and not from `query`, so asking
  // for somebody else's expenses narrows the result to nothing instead of
  // widening it.
  const filter: Record<string, unknown> = {
    organizationId: orgId,
    ...scopeFilter(scope, "submittedById"),
  };
  if (and.length) filter.$and = and;

  return filter;
}

export async function listExpenses(
  orgId: string,
  query: ExpenseQuery,
  scope: Scope,
): Promise<Paginated<ExpenseDTO>> {
  const filter = expenseListFilter(orgId, query, scope);
  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    Expense.find(filter).sort(sort).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize)
      .populate("departmentId", "name"),
    Expense.countDocuments(filter),
  ]);
  return { data: rows.map((r) => toDTO(r as unknown as ExpenseDoc)), meta: pageMeta(total, query.page, query.pageSize) };
}

/**
 * The Expenses list's cards (the user, 2026-10-21): how many the filters match and their money — total,
 * paid, unpaid, overdue — per currency, never added across currencies. Voided and rejected ones are
 * counted but their money left out (it was not spent), unless the status filter asks for them.
 */
export async function expenseSummary(orgId: string, query: ExpenseQuery, scope: Scope): Promise<ExpenseSummary> {
  const filter = Expense.find().cast(Expense, expenseListFilter(orgId, query, scope));
  const todayStart = new Date(new Date().toISOString().slice(0, 10));
  const notSpent = query.status === "voided" || query.status === "rejected" ? [] : ["voided", "rejected"];
  const unpaid = { $eq: [{ $ifNull: ["$paidOn", null] }, null] };
  const overdue = { $and: [unpaid, { $ne: [{ $ifNull: ["$dueDate", null] }, null] }, { $lt: ["$dueDate", todayStart] }] };
  const sumIf = (cond: unknown, what: unknown) => ({ $sum: { $cond: [cond, what, 0] } });
  const [all, groups] = await Promise.all([
    Expense.countDocuments(filter),
    Expense.aggregate<{ _id: string | null } & Omit<ExpenseSummaryCurrency, "currency">>([
      { $match: { ...filter, status: { $nin: notSpent } } },
      {
        $group: {
          _id: "$currency",
          count: { $sum: 1 },
          totalMinor: { $sum: "$totalMinor" },
          paidMinor: sumIf({ $not: [unpaid] }, "$totalMinor"),
          paidCount: sumIf({ $not: [unpaid] }, 1),
          unpaidMinor: sumIf({ $and: [unpaid, { $not: [overdue] }] }, "$totalMinor"),
          unpaidCount: sumIf({ $and: [unpaid, { $not: [overdue] }] }, 1),
          overdueMinor: sumIf(overdue, "$totalMinor"),
          overdueCount: sumIf(overdue, 1),
        },
      },
      { $sort: { totalMinor: -1 } },
    ]),
  ]);
  const byCurrency = groups.map(({ _id, ...g }) => ({ currency: _id || "AED", ...g }));
  return { count: all, leftOut: all - byCurrency.reduce((n, g) => n + g.count, 0), byCurrency };
}

export async function getExpense(orgId: string, id: string, scope: Scope): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  assertOwned(scope, doc.submittedById, "Expense");
  return toDTO(doc as unknown as ExpenseDoc);
}

/* ── The Banking account it is paid from, and its line there (2026-10-16) ──────────────────────────────────────── */

/**
 * Sets the account on an expense about to be saved: the one named ("" for none), else the one it has, else its
 * method's (Settings → Where payments go — cash to petty cash). Its name goes in `paymentAccount`, which every older
 * screen shows. One named that is not this organization's, or is closed, is refused.
 */
export async function applyExpenseAccount(orgId: string, d: Record<string, unknown>, named: string | undefined): Promise<void> {
  let id: string | null;
  if (named !== undefined) {
    id = named || null;
    if (id) {
      const acc = await debitAccount(orgId, id, "");
      if ("note" in acc) throw new AppError("VALIDATION_ERROR", acc.note);
    }
  } else if (d.bankAccountId) {
    id = String(d.bankAccountId);
  } else {
    const method = d.paymentMethod as string | undefined;
    id = method ? (await paymentAccountsOf(orgId))[method] ?? null : null;
  }
  if (!id) {
    d.bankAccountId = null;
    return;
  }
  const acc = await debitAccount(orgId, id, "");
  if ("note" in acc) {
    // A method's account that has gone or closed is ignored; a named one was checked above.
    d.bankAccountId = null;
    return;
  }
  d.bankAccountId = new Types.ObjectId(acc.id);
  d.paymentAccount = acc.name;
}

/**
 * Brings a saved expense's money-out line into line with it: there while it is paid from an account in its currency
 * and not voided or rejected; gone otherwise. Never throws — what could not be done is said on the expense.
 */
export async function syncExpenseLine(orgId: string, id: unknown): Promise<void> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).lean<any>();
  if (!doc) return;
  let note = "";
  let want: Parameters<typeof syncDebitLine>[2] = null;
  // Not while it waits for a manager to approve it being entered late.
  if (doc.bankAccountId && doc.paidOn && !["voided", "rejected"].includes(doc.status) && !isLatePending(doc.lateEntry)) {
    const acc = await debitAccount(orgId, String(doc.bankAccountId), doc.currency ?? "AED");
    if ("note" in acc) note = acc.note;
    else {
      want = {
        accountId: acc.id,
        date: new Date(doc.paidOn),
        amountMinor: doc.totalMinor ?? 0,
        description: `${doc.expenseNumber} · ${doc.description ?? ""}`.trim(),
        reference: String(doc.reference || doc.expenseNumber),
        match: { type: "expense", referenceId: String(doc._id), referenceNumber: doc.expenseNumber },
      };
    }
  }
  try {
    const txId = await syncDebitLine(orgId, doc.bankTransactionId, want);
    await Expense.updateOne({ _id: doc._id }, { $set: { bankTransactionId: txId, bankNote: note } });
  } catch (err) {
    await Expense.updateOne({ _id: doc._id }, { $set: { bankNote: `Not put in the account: ${(err as Error).message}`.slice(0, 300) } });
  }
}

/**
 * An expense another part of finance made already paid — a salary advance or a one-time payment HR sent — put in its
 * method's account (unless it has one), with its money-out line. Never throws.
 */
export async function placeExpenseInBank(orgId: string, id: unknown): Promise<void> {
  try {
    const doc = await Expense.findOne({ _id: id, organizationId: orgId });
    if (!doc) return;
    const d = doc as unknown as Record<string, unknown>;
    if (!d.bankAccountId) {
      await applyExpenseAccount(orgId, d, undefined);
      if (doc.isModified()) await doc.save();
    }
    await syncExpenseLine(orgId, doc._id);
  } catch {
    /* the payment is recorded; its line can be put in by editing it */
  }
}

/** The expense as saved, its line in its account brought into line first. */
async function syncedDTO(orgId: string, id: unknown): Promise<ExpenseDTO> {
  await syncExpenseLine(orgId, id);
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function createExpense(
  orgId: string,
  userId: string,
  input: CreateExpenseInput,
  /** Who is typing it in — only the Expenses screen passes it: dated too far back, it waits for a manager. */
  late?: LateActor,
): Promise<ExpenseDTO> {
  const user = await User.findOne({ _id: userId, "memberships.organizationId": orgId });
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  // The claimed figure is read as gross or net depending on the receipt; what
  // gets stored is the same either way — net in amountMinor, gross in
  // totalMinor — so nothing downstream has to know which was typed.
  const taxInclusive = input.taxInclusive ?? false;
  const { netMinor, taxMinor, totalMinor } = computeExpenseTax(
    input.amountMinor,
    input.taxPct ?? 0,
    taxInclusive,
  );
  const expenseNumber = await nextNumber(orgId, "expense", "EXP-");

  const mileage = input.mileage
    ? {
        distanceKm: input.mileage.distanceKm,
        ratePerKmMinor: input.mileage.ratePerKmMinor,
        totalMinor: Math.round(input.mileage.distanceKm * input.mileage.ratePerKmMinor),
      }
    : undefined;

  const status = input.requiresApproval ? "submitted" : "approved";

  const cat = await resolveExpenseCategory(orgId, input.category, input.subcategory);
  const displayName = resolveCategoryName(cat.category, cat.categoryName, input.categoryOther);

  if (input.departmentId) await requireOrgDepartment(orgId, input.departmentId);
  const salesperson = input.salespersonId ? await requireOrgSalesperson(orgId, input.salespersonId) : null;

  const lateNow = await lateForDate(orgId, late, input.expenseDate, null, null);
  const doc = await Expense.create({
    organizationId: new Types.ObjectId(orgId),
    expenseNumber,
    lateEntry: lateNow.next ?? null,
    category: cat.category,
    categoryName: displayName,
    subcategory: cat.subcategory,
    subcategoryName: cat.subcategoryName,
    description: input.description,
    expenseDate: new Date(input.expenseDate),
    amountMinor: netMinor,
    taxPct: input.taxPct ?? 0,
    taxInclusive,
    taxMinor,
    totalMinor,
    currency: input.currency ?? "AED",
    ...(await (async () => {
      const acc: Record<string, unknown> = { paymentMethod: input.paymentMethod, paymentAccount: input.paymentAccount ?? "" };
      await applyExpenseAccount(orgId, acc, input.bankAccountId);
      return { bankAccountId: acc.bankAccountId ?? null, paymentAccount: acc.paymentAccount };
    })()),
    paymentMethod: input.paymentMethod,
    reference: input.reference ?? "",
    dueDate: input.dueDate ? new Date(input.dueDate) : undefined,
    submittedById: new Types.ObjectId(userId),
    submittedByName: user.name,
    status,
    isRecurring: input.isRecurring ?? false,
    recurrence: input.recurrence
      ? {
          frequency: input.recurrence.frequency,
          nextDate: new Date(input.recurrence.nextDate),
          endDate: input.recurrence.endDate ? new Date(input.recurrence.endDate) : undefined,
          isActive: input.recurrence.isActive ?? true,
        }
      : undefined,
    mileage,
    // Paid already from its account (2026-10-22): money out there at once (syncedDTO below puts the line in). Not one
    // that waits for approval — that is paid once approved.
    ...(input.paidOn && status === "approved" ? { paidOn: new Date(input.paidOn) } : {}),
    attachments: await resolveAttachments(orgId, input.attachments ?? [], []),
    projectName: input.projectName ?? "",
    departmentId: input.departmentId ? new Types.ObjectId(input.departmentId) : undefined,
    ...(salesperson ? { salespersonId: salesperson.id, salespersonName: salesperson.name } : {}),
    costCentre: input.costCentre ?? "",
    notes: input.notes ?? "",
  });

  if (lateNow.pending) await openLateEntry(orgId, lateNow.pending, lateInfo(doc));
  // A freshly created document holds the raw id, so the DTO would report no
  // department on the one response that shows what was just saved.
  return syncedDTO(orgId, doc._id);
}

export async function updateExpense(
  orgId: string,
  id: string,
  input: UpdateExpenseInput,
  scope: Scope,
  late?: LateActor,
): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  assertOwned(scope, doc.submittedById, "Expense");
  if (doc.status === "voided")
    throw new AppError("CONFLICT", "A voided expense can't be edited");
  // Someone editing their own claim may do so until it is with an approver.
  // Afterwards the amount has been approved, and changing it would mean the
  // approval was given to something else.
  if (!scope.all && !["draft", "rejected"].includes(doc.status as string)) {
    throw new AppError("CONFLICT", "A submitted expense can't be edited");
  }

  const d = doc as unknown as Record<string, unknown>;

  if (input.category !== undefined || input.subcategory !== undefined || input.categoryOther !== undefined) {
    const category = input.category ?? (d.category as string);
    const same = category === d.category;
    // Its category kept: its subcategory stays unless changed, and an older expense without one may stay so.
    const sub = input.subcategory !== undefined ? input.subcategory : same ? (d.subcategory as string | null) : null;
    const cat = await resolveExpenseCategory(orgId, category, sub, { optionalSub: same && input.subcategory === undefined });
    d.category = cat.category;
    d.categoryName = resolveCategoryName(cat.category, cat.categoryName, input.categoryOther);
    d.subcategory = cat.subcategory;
    d.subcategoryName = cat.subcategoryName;
  }
  if (input.description !== undefined) doc.description = input.description;
  // Its date moved: too far back and it waits for a manager; back within the days and it no longer does.
  const lateNow = input.expenseDate !== undefined
    ? await lateForDate(orgId, late, input.expenseDate, d.expenseDate as Date, d.lateEntry as never)
    : null;
  if (lateNow && lateNow.next !== undefined) d.lateEntry = lateNow.next;
  if (input.expenseDate !== undefined) d.expenseDate = new Date(input.expenseDate);
  if (input.currency !== undefined) d.currency = input.currency;
  if (input.paymentAccount !== undefined) d.paymentAccount = input.paymentAccount;
  if (input.paymentMethod !== undefined) d.paymentMethod = input.paymentMethod;
  if (input.bankAccountId !== undefined || (input.paymentMethod !== undefined && !d.bankAccountId)) {
    await applyExpenseAccount(orgId, d, input.bankAccountId);
  }
  if (input.reference !== undefined) d.reference = input.reference;
  // Clearable: an empty string means "no date to meet", which is a real answer
  // and different from not mentioning the field at all.
  if (input.dueDate !== undefined) d.dueDate = input.dueDate ? new Date(input.dueDate) : undefined;
  if (input.notes !== undefined) doc.notes = input.notes;
  if (input.projectName !== undefined) d.projectName = input.projectName;
  if (input.salespersonId !== undefined) {
    if (input.salespersonId) {
      const sp = await requireOrgSalesperson(orgId, input.salespersonId);
      d.salespersonId = sp.id;
      d.salespersonName = sp.name;
    } else {
      d.salespersonId = undefined;
      d.salespersonName = undefined;
    }
  }
  if (input.departmentId !== undefined) {
    if (input.departmentId) {
      await requireOrgDepartment(orgId, input.departmentId);
      d.departmentId = new Types.ObjectId(input.departmentId);
    } else {
      d.departmentId = undefined;
    }
  }
  if (input.costCentre !== undefined) d.costCentre = input.costCentre;
  if (input.isRecurring !== undefined) d.isRecurring = input.isRecurring;
  if (input.recurrence !== undefined) {
    d.recurrence = input.recurrence
      ? {
          frequency: input.recurrence.frequency,
          nextDate: new Date(input.recurrence.nextDate),
          endDate: input.recurrence.endDate ? new Date(input.recurrence.endDate) : undefined,
          isActive: input.recurrence.isActive ?? true,
        }
      : undefined;
  }
  // Kept whole — key, size, type — so a later delete still finds the file (they used to lose the key here).
  let droppedKeys: string[] = [];
  if (input.attachments !== undefined) {
    // Plain copies: Mongoose subdocuments would carry their own fields along.
    const before = JSON.parse(JSON.stringify(d.attachments ?? [])) as StoredAttachment[];
    const next = await resolveAttachments(orgId, input.attachments, before);
    const kept = new Set(next.map((a) => a.key).filter(Boolean));
    droppedKeys = before.map((a) => a.key).filter((k): k is string => !!k && !kept.has(k));
    d.attachments = next;
  }

  if (
    input.amountMinor !== undefined ||
    input.taxPct !== undefined ||
    input.taxInclusive !== undefined
  ) {
    const inclusive = input.taxInclusive ?? ((doc.taxInclusive as boolean | undefined) ?? false);
    const tax = input.taxPct ?? ((doc.taxPct as number) ?? 0);
    // What was typed, not what was stored: amountMinor holds the net, so an
    // edit that only changes the rate has to start from the gross again when
    // the claim was entered tax-inclusive, or the figure would shrink each time.
    const typed =
      input.amountMinor ??
      (inclusive ? ((doc.totalMinor as number) ?? 0) : ((doc.amountMinor as number) ?? 0));

    const r = computeExpenseTax(typed, tax, inclusive);
    doc.amountMinor = r.netMinor;
    doc.taxPct = tax;
    doc.set("taxInclusive", inclusive);
    doc.taxMinor = r.taxMinor;
    doc.totalMinor = r.totalMinor;
  }

  if (input.mileage !== undefined) {
    d.mileage = input.mileage
      ? {
          distanceKm: input.mileage.distanceKm,
          ratePerKmMinor: input.mileage.ratePerKmMinor,
          totalMinor: Math.round(input.mileage.distanceKm * input.mileage.ratePerKmMinor),
        }
      : undefined;
  }

  // Its line in the bank follows — unless a bank statement was reconciled against it.
  if (d.bankTransactionId && doc.isModified(["totalMinor", "paidOn", "bankAccountId", "currency"])) await assertDebitMovable(orgId, d.bankTransactionId);
  // Waiting for a manager again, a paid one leaves its account until it is approved.
  if (d.bankTransactionId && lateNow?.pending) await assertDebitMovable(orgId, d.bankTransactionId);
  await doc.save();
  if (lateNow?.pending) await openLateEntry(orgId, lateNow.pending, lateInfo(doc));
  else if (lateNow?.withdraw) await withdrawLateFor(orgId, "expense", doc._id);
  if (droppedKeys.length) await deleteUnusedFiles(orgId, droppedKeys, doc._id);
  return syncedDTO(orgId, doc._id);
}

/** What the managers are shown of it. */
function lateInfo(doc: unknown) {
  const x = doc as Record<string, any>;
  return {
    kind: "expense" as const, refId: x._id, number: String(x.expenseNumber ?? ""), title: String(x.description ?? ""),
    amountMinor: Number(x.totalMinor ?? 0), currency: String(x.currency ?? "AED"),
  };
}

/** Refused while a manager has still to approve it being entered late. */
function assertNotWaiting(doc: unknown, what: string): void {
  if (isLatePending((doc as { lateEntry?: unknown }).lateEntry)) {
    throw new AppError("CONFLICT", `It was entered late and is waiting for a manager — it can't be ${what} until one approves it`);
  }
}

export async function submitExpense(orgId: string, id: string, scope: Scope): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  assertOwned(scope, doc.submittedById, "Expense");
  if (!["draft", "rejected"].includes(doc.status as string))
    throw new AppError("CONFLICT", "Only draft or rejected expenses can be submitted");
  // Not "enter it again": that made a second expense for the same money (2026-10-22). Its date changed to one that is
  // not late, the rejection no longer stands (lateForDate) and it can be sent.
  if ((doc as unknown as { lateEntry?: { state?: string } }).lateEntry?.state === "rejected") {
    throw new AppError("CONFLICT", `A manager rejected it being entered late — give it a date from ${lateEntryCutoff(await lateEntryDaysOf(orgId))} on to send it again`);
  }
  doc.status = "submitted";
  await doc.save();
  // Not awaited: the claim is submitted either way, and a mail outage must not
  // hold up the response or turn into a failure to submit.
  void notifyApproversOfSubmission(doc as unknown as ExpenseDoc);
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function approveExpense(
  orgId: string,
  id: string,
  approverId: string,
  approverName: string,
): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  if (doc.status !== "submitted") throw new AppError("CONFLICT", "Only submitted expenses can be approved");
  assertNotWaiting(doc, "approved");

  const d = doc as unknown as Record<string, unknown>;
  doc.status = "approved";
  d.approvedById = new Types.ObjectId(approverId);
  d.approvedByName = approverName;
  d.approvedAt = new Date();
  d.rejectedReason = undefined;
  await doc.save();
  void notifyExpenseApproved(doc as unknown as ExpenseDoc, approverName);
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function rejectExpense(
  orgId: string,
  id: string,
  approverId: string,
  approverName: string,
  input: RejectExpenseInput,
): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  if (doc.status !== "submitted") throw new AppError("CONFLICT", "Only submitted expenses can be rejected");

  const d = doc as unknown as Record<string, unknown>;
  doc.status = "rejected";
  d.approvedById = new Types.ObjectId(approverId);
  d.approvedByName = approverName;
  d.approvedAt = new Date();
  d.rejectedReason = input.reason;
  await doc.save();
  void notifyExpenseRejected(doc as unknown as ExpenseDoc, approverName, input.reason);
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function voidExpense(orgId: string, id: string): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  if (doc.status === "voided")
    throw new AppError("CONFLICT", "Expense is already voided");
  doc.status = "voided";
  await assertDebitMovable(orgId, (doc as unknown as { bankTransactionId?: unknown }).bankTransactionId);
  await doc.save();
  await withdrawLateFor(orgId, "expense", doc._id);
  return syncedDTO(orgId, doc._id);
}

/**
 * Remove an expense that should not be on the books at all (the user,
 * 2026-10-16: "expense delete also") — entered twice, against the wrong
 * department, left by a test. Any status, paid ones too; voiding, which keeps
 * it on the record as cancelled, remains the ordinary way to cancel a real one.
 *
 * Not one that came from somewhere else, which keeps its number: a purchase
 * request, salary advance or one-time payment from HRMS (HRMS holds its EXP
 * number, and a resend would record it a second time), or one a payroll payment
 * posted. Those are voided. Its receipts go from storage with it.
 */
export async function deleteExpense(orgId: string, id: string): Promise<void> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  const kind = String((doc as unknown as { source?: { kind?: string } }).source?.kind ?? "");
  if (kind.startsWith("hrms_")) {
    throw new AppError("CONFLICT", `${doc.expenseNumber} came from HRMS, which keeps its number — void it instead.`);
  }
  const { PayrollRun } = await import("../payroll/payroll-run.model");
  if (await PayrollRun.exists({ organizationId: orgId, "payments.expenseId": doc._id })) {
    throw new AppError("CONFLICT", `${doc.expenseNumber} was posted by a payroll payment — void it from the payroll run instead.`);
  }
  const keys = ((doc as unknown as { attachments?: { key?: string }[] }).attachments ?? []).map((a) => a.key).filter(Boolean) as string[];
  // Its line in the bank goes with it — not once a bank statement was reconciled against it.
  const line = (doc as unknown as { bankTransactionId?: unknown }).bankTransactionId;
  await assertDebitMovable(orgId, line);
  await doc.deleteOne();
  if (line) await syncDebitLine(orgId, line, null);
  await withdrawLateFor(orgId, "expense", doc._id);
  if (keys.length) {
    // A recurring expense's copies share its files: only one nothing else holds goes.
    await deleteUnusedFiles(orgId, keys, doc._id);
  }
}

// ── Recurring template controls ────────────────────────────────────────────────

/** Pause (isActive=false) or resume (isActive=true) a recurring expense template.
 *  A paused template is skipped by the generator until resumed. */
/**
 * Recording that a claim was settled.
 *
 * The approval status says whether the claim was agreed to; this says whether
 * the money left. They are different questions and were previously the same
 * one, so an approved claim from March and one paid yesterday read alike.
 *
 * A voided or rejected claim cannot be paid, because both mean it was decided
 * against. Everything else can: a draft is often a spend that has already
 * happened, and refusing to record what the bank statement plainly shows would
 * make the field a worse record than the statement.
 *
 * Method, account and reference are optional and only overwrite when given —
 * the expense may already carry them from when it was created, and passing
 * nothing should not blank what is there.
 */
export async function markExpensePaid(
  orgId: string,
  id: string,
  input: MarkExpensePaidInput,
): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");

  const status = doc.status as string;
  if (status === "voided") throw new AppError("CONFLICT", "A voided expense cannot be marked paid");
  if (status === "rejected") throw new AppError("CONFLICT", "A rejected expense cannot be marked paid");
  assertNotWaiting(doc, "marked paid");

  const d = doc as unknown as Record<string, unknown>;
  d.paidOn = new Date(input.paidOn);
  if (input.paymentMethod !== undefined) d.paymentMethod = input.paymentMethod;
  if (input.paymentAccount !== undefined) d.paymentAccount = input.paymentAccount;
  await applyExpenseAccount(orgId, d, input.bankAccountId);
  if (input.reference !== undefined) d.reference = input.reference;
  if (d.bankTransactionId && doc.isModified(["totalMinor", "paidOn", "bankAccountId", "currency"])) await assertDebitMovable(orgId, d.bankTransactionId);
  await doc.save();
  return syncedDTO(orgId, doc._id);
}

/**
 * Undoing that, for when it was marked paid by mistake.
 *
 * Only the date goes. Method, account and reference are left alone: they were
 * often filled in when the claim was created, describing how it was meant to be
 * paid, and clearing them here would throw away something this never set.
 */
export async function markExpenseUnpaid(orgId: string, id: string): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  if (!(doc as unknown as Record<string, unknown>).paidOn) {
    throw new AppError("CONFLICT", "This expense is not marked paid");
  }
  (doc as unknown as Record<string, unknown>).paidOn = undefined;
  await assertDebitMovable(orgId, (doc as unknown as { bankTransactionId?: unknown }).bankTransactionId);
  await doc.save();
  return syncedDTO(orgId, doc._id);
}

export async function setRecurrenceActive(
  orgId: string,
  id: string,
  isActive: boolean,
): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  const d = doc as unknown as Record<string, unknown>;
  if (!doc.isRecurring || !d.recurrence)
    throw new AppError("CONFLICT", "This expense is not a recurring template");
  (d.recurrence as { isActive?: boolean }).isActive = isActive;
  doc.markModified("recurrence");
  await doc.save();
  return toDTO(doc as unknown as ExpenseDoc);
}

/** Stop a recurring template for good — no further expenses will be generated.
 *  Past generated expenses are untouched. */
export async function stopRecurrence(orgId: string, id: string): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  if (!doc.isRecurring)
    throw new AppError("CONFLICT", "This expense is not a recurring template");
  doc.isRecurring = false;
  await doc.save();
  return toDTO(doc as unknown as ExpenseDoc);
}


/**
 * How many receipts one claim may carry.
 *
 * A claim needs a receipt, sometimes a few. It does not need hundreds, and
 * without a ceiling an account with `expense:write:own` is an unmetered place
 * to put files.
 */
const MAX_ATTACHMENTS = 10;

// ── Supporting documents: uploaded, never pasted (2026-10-20) ─────────────────

interface StoredAttachment { name: string; url: string; key?: string; size?: number; mimeType?: string; uploadedAt?: Date }

/** Where the expense form's uploads wait until the expense is saved with them. */
const uploadPrefix = (orgId: string) => `expenses/${orgId}/uploads/`;

/**
 * A file picked on the New / Edit Expense form, stored before the expense is saved — so whoever only enters their
 * own claims can attach documents too (a claim created submitted or approved takes no receipts afterwards).
 */
export async function uploadFormFile(orgId: string, file: ParsedFile): Promise<UploadedExpenseFile> {
  const { uploadFile, storageConfigured } = await import("../../lib/storage");
  if (!storageConfigured()) throw new AppError("VALIDATION_ERROR", "File storage is not configured");
  // The uploader's filename never becomes the key on its own (see addAttachment).
  const safe = file.originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const key = `${uploadPrefix(orgId)}${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safe}`;
  const up = await uploadFile({ key, buffer: file.buffer, mimeType: file.mimeType, originalName: file.originalName });
  return { name: file.originalName.slice(0, 200), key: up.key, url: up.url, size: up.size, mimeType: up.mimeType };
}

/**
 * The documents to save: each one already on the expense (by key, or an old link by its url) as it was stored, and
 * each new one uploaded through uploadFormFile for this organization — its address built here. A pasted link, or a
 * key from anywhere else, is refused.
 */
async function resolveAttachments(orgId: string, input: ExpenseAttachmentInput[], existing: StoredAttachment[]): Promise<StoredAttachment[]> {
  if (input.length > MAX_ATTACHMENTS) throw new AppError("VALIDATION_ERROR", `An expense can hold at most ${MAX_ATTACHMENTS} documents`);
  const { publicUrlFor } = await import("../../lib/storage");
  const out: StoredAttachment[] = [];
  for (const a of input) {
    const name = a.name.trim().slice(0, 200);
    const had = existing.find((e) => (a.key ? e.key === a.key : !e.key && e.url === a.url));
    if (had) { out.push({ ...had, name: name || had.name }); continue; }
    if (!a.key) throw new AppError("VALIDATION_ERROR", "Upload the document — links are not accepted");
    if (!a.key.startsWith(uploadPrefix(orgId)) || a.key.includes("..")) {
      throw new AppError("VALIDATION_ERROR", "That document was not uploaded here — upload it again");
    }
    out.push({ name, url: publicUrlFor(a.key), key: a.key, size: a.size, mimeType: a.mimeType, uploadedAt: new Date() });
  }
  return out;
}

/** Deletes the stored files that no expense of this organization holds any more (copies of a recurring one share them). */
async function deleteUnusedFiles(orgId: string, keys: string[], exceptId: unknown): Promise<void> {
  const held = await Expense.find({ organizationId: orgId, _id: { $ne: exceptId }, "attachments.key": { $in: keys } })
    .select("attachments.key").lean<{ attachments?: { key?: string }[] }[]>();
  const stillUsed = new Set(held.flatMap((e) => (e.attachments ?? []).map((a) => a.key)));
  const { deleteFile } = await import("../../lib/storage");
  await Promise.all(keys.filter((k) => !stillUsed.has(k)).map((k) => deleteFile(k).catch(() => undefined)));
}

/**
 * A claim only takes receipts while it is still the claimant's.
 *
 * Once submitted it is with an approver, and once approved the amount has been
 * agreed against the evidence attached at the time. Adding to or removing from
 * it afterwards changes what was approved.
 */
function assertAttachable(status: string, scope: Scope): void {
  if (scope.all) return;
  if (!["draft", "rejected"].includes(status)) {
    throw new AppError("CONFLICT", "Receipts can only be changed while the claim is a draft");
  }
}

export async function addAttachment(
  orgId: string,
  id: string,
  file: ParsedFile,
  scope: Scope,
): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  assertOwned(scope, doc.submittedById, "Expense");
  assertAttachable(doc.status as string, scope);

  const existing = (doc.attachments as unknown as unknown[]) ?? [];
  if (existing.length >= MAX_ATTACHMENTS) {
    throw new AppError("CONFLICT", `A claim can hold at most ${MAX_ATTACHMENTS} receipts`);
  }

  const { uploadFile, storageConfigured } = await import("../../lib/storage");
  if (!storageConfigured()) throw new AppError("VALIDATION_ERROR", "File storage is not configured");

  // The uploader's filename never becomes the key. It is theirs to choose, and
  // a key built from it could otherwise reach outside this expense's prefix.
  const safe = file.originalName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const key = `expenses/${orgId}/${id}/${Date.now()}-${safe}`;
  const uploaded = await uploadFile({
    key,
    buffer: file.buffer,
    mimeType: file.mimeType,
    originalName: file.originalName,
  });

  (doc.attachments as unknown as Record<string, unknown>[]).push({
    name: file.originalName.slice(0, 200),
    url: uploaded.url,
    key: uploaded.key,
    size: uploaded.size,
    mimeType: uploaded.mimeType,
    uploadedAt: new Date(),
  });
  await doc.save();
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function removeAttachment(
  orgId: string,
  id: string,
  key: string,
  scope: Scope,
): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  assertOwned(scope, doc.submittedById, "Expense");
  assertAttachable(doc.status as string, scope);

  const list = doc.attachments as unknown as { key?: string }[];
  const idx = list.findIndex((a) => a.key === key);
  if (idx === -1) throw new AppError("NOT_FOUND", "Receipt not found");

  list.splice(idx, 1);
  await doc.save();

  // After the record, so a storage failure cannot leave the row pointing at an
  // object that is gone. An orphaned object costs storage; a row pointing at
  // nothing is a broken link in front of somebody.
  const { deleteFile } = await import("../../lib/storage");
  await deleteFile(key).catch(() => undefined);

  return toDTO(doc as unknown as ExpenseDoc);
}
