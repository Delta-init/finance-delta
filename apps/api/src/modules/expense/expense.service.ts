import { Types } from "mongoose";
import type {
  CreateExpenseInput,
  UpdateExpenseInput,
  Expense as ExpenseDTO,
  ExpenseQuery,
  Paginated,
  RejectExpenseInput,
} from "@delta/shared";
import { EXPENSE_CATEGORY_LABELS, computeExpenseTax, resolveCategoryName } from "@delta/shared";
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
import { categoryNameMap } from "../expense-category/expense-category.service";

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
    description: doc.description,
    expenseDate: dateOnly(doc.expenseDate as unknown as Date),
    amountMinor: (doc.amountMinor as number) ?? 0,
    taxPct: (doc.taxPct as number) ?? 0,
    taxInclusive: (doc.taxInclusive as boolean) ?? false,
    taxMinor: (doc.taxMinor as number) ?? 0,
    totalMinor: (doc.totalMinor as number) ?? 0,
    currency: (doc.currency as string) ?? "AED",
    paymentAccount: (doc.paymentAccount as string) ?? "",
    paymentMethod: (d.paymentMethod as ExpenseDTO["paymentMethod"]) ?? undefined,
    reference: (doc.reference as string) ?? "",
    submittedById: String(doc.submittedById),
    submittedByName: doc.submittedByName,
    status: doc.status as ExpenseDTO["status"],
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

export async function listExpenses(
  orgId: string,
  query: ExpenseQuery,
  scope: Scope,
): Promise<Paginated<ExpenseDTO>> {
  const and: Record<string, unknown>[] = [];
  const or = searchOr(query.q, ["expenseNumber", "description", "submittedByName"]);
  if (or) and.push({ $or: or });
  if (query.status) and.push({ status: query.status });
  if (query.category) and.push({ category: query.category });
  if (query.submittedById) and.push({ submittedById: new Types.ObjectId(query.submittedById) });
  if (query.dateFrom) and.push({ expenseDate: { $gte: new Date(query.dateFrom) } });
  if (query.dateTo) and.push({ expenseDate: { $lte: new Date(query.dateTo) } });
  if (query.projectName) and.push({ projectName: { $regex: query.projectName, $options: "i" } });
  if (query.costCentre) and.push({ costCentre: { $regex: query.costCentre, $options: "i" } });
  if (query.departmentId) and.push({ departmentId: new Types.ObjectId(query.departmentId) });
  if (query.isRecurring !== undefined) and.push({ isRecurring: query.isRecurring });

  // Applied after the caller's own filters, and not from `query`, so asking
  // for somebody else's expenses narrows the result to nothing instead of
  // widening it.
  const filter: Record<string, unknown> = {
    organizationId: orgId,
    ...scopeFilter(scope, "submittedById"),
  };
  if (and.length) filter.$and = and;

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    Expense.find(filter).sort(sort).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize)
      .populate("departmentId", "name"),
    Expense.countDocuments(filter),
  ]);
  return { data: rows.map((r) => toDTO(r as unknown as ExpenseDoc)), meta: pageMeta(total, query.page, query.pageSize) };
}

export async function getExpense(orgId: string, id: string, scope: Scope): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  assertOwned(scope, doc.submittedById, "Expense");
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function createExpense(
  orgId: string,
  userId: string,
  input: CreateExpenseInput,
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

  const catMap = await categoryNameMap(orgId);
  const catName = catMap.get(input.category);
  if (!catName) throw new AppError("VALIDATION_ERROR", `Unknown expense category "${input.category}"`);
  const displayName = resolveCategoryName(input.category, catName, input.categoryOther);

  if (input.departmentId) await requireOrgDepartment(orgId, input.departmentId);

  const doc = await Expense.create({
    organizationId: new Types.ObjectId(orgId),
    expenseNumber,
    category: input.category,
    categoryName: displayName,
    description: input.description,
    expenseDate: new Date(input.expenseDate),
    amountMinor: netMinor,
    taxPct: input.taxPct ?? 0,
    taxInclusive,
    taxMinor,
    totalMinor,
    currency: input.currency ?? "AED",
    paymentAccount: input.paymentAccount ?? "",
    paymentMethod: input.paymentMethod,
    reference: input.reference ?? "",
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
    attachments: (input.attachments ?? []).map((a) => ({ name: a.name, url: a.url })),
    projectName: input.projectName ?? "",
    departmentId: input.departmentId ? new Types.ObjectId(input.departmentId) : undefined,
    costCentre: input.costCentre ?? "",
    notes: input.notes ?? "",
  });

  // A freshly created document holds the raw id, so the DTO would report no
  // department on the one response that shows what was just saved.
  if (doc.departmentId) await doc.populate("departmentId", "name");
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function updateExpense(
  orgId: string,
  id: string,
  input: UpdateExpenseInput,
  scope: Scope,
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

  if (input.category !== undefined || input.categoryOther !== undefined) {
    const category = input.category ?? (d.category as string);
    const catMap = await categoryNameMap(orgId);
    const nm = catMap.get(category);
    if (!nm) throw new AppError("VALIDATION_ERROR", `Unknown expense category "${category}"`);
    d.category = category;
    d.categoryName = resolveCategoryName(category, nm, input.categoryOther);
  }
  if (input.description !== undefined) doc.description = input.description;
  if (input.expenseDate !== undefined) d.expenseDate = new Date(input.expenseDate);
  if (input.currency !== undefined) d.currency = input.currency;
  if (input.paymentAccount !== undefined) d.paymentAccount = input.paymentAccount;
  if (input.paymentMethod !== undefined) d.paymentMethod = input.paymentMethod;
  if (input.reference !== undefined) d.reference = input.reference;
  if (input.notes !== undefined) doc.notes = input.notes;
  if (input.projectName !== undefined) d.projectName = input.projectName;
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
  if (input.attachments !== undefined) {
    d.attachments = input.attachments.map((a) => ({ name: a.name, url: a.url }));
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

  await doc.save();
  if (doc.departmentId) await doc.populate("departmentId", "name");
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function submitExpense(orgId: string, id: string, scope: Scope): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId }).populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  assertOwned(scope, doc.submittedById, "Expense");
  if (!["draft", "rejected"].includes(doc.status as string))
    throw new AppError("CONFLICT", "Only draft or rejected expenses can be submitted");
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
  await doc.save();
  return toDTO(doc as unknown as ExpenseDoc);
}

// ── Recurring template controls ────────────────────────────────────────────────

/** Pause (isActive=false) or resume (isActive=true) a recurring expense template.
 *  A paused template is skipped by the generator until resumed. */
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
