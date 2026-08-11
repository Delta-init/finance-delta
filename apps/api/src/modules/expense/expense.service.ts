import { Types } from "mongoose";
import type {
  CreateExpenseInput,
  UpdateExpenseInput,
  Expense as ExpenseDTO,
  ExpenseQuery,
  Paginated,
  RejectExpenseInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { Expense, type ExpenseDoc } from "./expense.model";
import { User } from "../user/user.model";
import { nextNumber } from "../sequence/sequence.service";

function dateOnly(d: Date | undefined): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function toDTO(doc: ExpenseDoc): ExpenseDTO {
  const d = doc as unknown as Record<string, unknown>;
  const rec = d.recurrence as { frequency: string; nextDate: Date; endDate?: Date; isActive?: boolean } | undefined;
  const mil = d.mileage as { distanceKm: number; ratePerKmMinor: number; totalMinor: number } | undefined;
  const atts = (d.attachments as { name: string; url: string }[]) ?? [];

  return {
    id: doc._id.toString(),
    expenseNumber: doc.expenseNumber,
    category: doc.category as ExpenseDTO["category"],
    description: doc.description,
    expenseDate: dateOnly(doc.expenseDate as unknown as Date),
    amountMinor: (doc.amountMinor as number) ?? 0,
    taxPct: (doc.taxPct as number) ?? 0,
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
    attachments: atts.map((a) => ({ name: a.name, url: a.url })),
    projectName: (doc.projectName as string) ?? "",
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

export async function listExpenses(orgId: string, query: ExpenseQuery): Promise<Paginated<ExpenseDTO>> {
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
  if (query.isRecurring !== undefined) and.push({ isRecurring: query.isRecurring });

  const filter: Record<string, unknown> = { organizationId: orgId };
  if (and.length) filter.$and = and;

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    Expense.find(filter).sort(sort).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize),
    Expense.countDocuments(filter),
  ]);
  return { data: rows.map((r) => toDTO(r as unknown as ExpenseDoc)), meta: pageMeta(total, query.page, query.pageSize) };
}

export async function getExpense(orgId: string, id: string): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function createExpense(
  orgId: string,
  userId: string,
  input: CreateExpenseInput,
): Promise<ExpenseDTO> {
  const user = await User.findOne({ _id: userId, organizationId: orgId });
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  const taxMinor = Math.round(input.amountMinor * (input.taxPct ?? 0) / 100);
  const totalMinor = input.amountMinor + taxMinor;
  const expenseNumber = await nextNumber(orgId, "expense", "EXP-");

  const mileage = input.mileage
    ? {
        distanceKm: input.mileage.distanceKm,
        ratePerKmMinor: input.mileage.ratePerKmMinor,
        totalMinor: Math.round(input.mileage.distanceKm * input.mileage.ratePerKmMinor),
      }
    : undefined;

  const status = input.requiresApproval ? "submitted" : "approved";

  const doc = await Expense.create({
    organizationId: new Types.ObjectId(orgId),
    expenseNumber,
    category: input.category,
    description: input.description,
    expenseDate: new Date(input.expenseDate),
    amountMinor: input.amountMinor,
    taxPct: input.taxPct ?? 0,
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
    costCentre: input.costCentre ?? "",
    notes: input.notes ?? "",
  });

  return toDTO(doc as unknown as ExpenseDoc);
}

export async function updateExpense(
  orgId: string,
  id: string,
  input: UpdateExpenseInput,
): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  if (!["draft", "rejected"].includes(doc.status as string))
    throw new AppError("CONFLICT", "Only draft or rejected expenses can be edited");

  const d = doc as unknown as Record<string, unknown>;

  if (input.category !== undefined) d.category = input.category;
  if (input.description !== undefined) doc.description = input.description;
  if (input.expenseDate !== undefined) d.expenseDate = new Date(input.expenseDate);
  if (input.currency !== undefined) d.currency = input.currency;
  if (input.paymentAccount !== undefined) d.paymentAccount = input.paymentAccount;
  if (input.paymentMethod !== undefined) d.paymentMethod = input.paymentMethod;
  if (input.reference !== undefined) d.reference = input.reference;
  if (input.notes !== undefined) doc.notes = input.notes;
  if (input.projectName !== undefined) d.projectName = input.projectName;
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

  if (input.amountMinor !== undefined || input.taxPct !== undefined) {
    const amount = input.amountMinor ?? (doc.amountMinor as number);
    const tax = input.taxPct ?? (doc.taxPct as number ?? 0);
    doc.amountMinor = amount;
    doc.taxPct = tax;
    doc.taxMinor = Math.round(amount * tax / 100);
    doc.totalMinor = amount + doc.taxMinor;
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
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function submitExpense(orgId: string, id: string): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  if (!["draft", "rejected"].includes(doc.status as string))
    throw new AppError("CONFLICT", "Only draft or rejected expenses can be submitted");
  doc.status = "submitted";
  await doc.save();
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function approveExpense(
  orgId: string,
  id: string,
  approverId: string,
  approverName: string,
): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  if (doc.status !== "submitted") throw new AppError("CONFLICT", "Only submitted expenses can be approved");

  const d = doc as unknown as Record<string, unknown>;
  doc.status = "approved";
  d.approvedById = new Types.ObjectId(approverId);
  d.approvedByName = approverName;
  d.approvedAt = new Date();
  d.rejectedReason = undefined;
  await doc.save();
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function rejectExpense(
  orgId: string,
  id: string,
  approverId: string,
  approverName: string,
  input: RejectExpenseInput,
): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  if (doc.status !== "submitted") throw new AppError("CONFLICT", "Only submitted expenses can be rejected");

  const d = doc as unknown as Record<string, unknown>;
  doc.status = "rejected";
  d.approvedById = new Types.ObjectId(approverId);
  d.approvedByName = approverName;
  d.approvedAt = new Date();
  d.rejectedReason = input.reason;
  await doc.save();
  return toDTO(doc as unknown as ExpenseDoc);
}

export async function voidExpense(orgId: string, id: string): Promise<ExpenseDTO> {
  const doc = await Expense.findOne({ _id: id, organizationId: orgId });
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
  const doc = await Expense.findOne({ _id: id, organizationId: orgId });
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
  const doc = await Expense.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Expense not found");
  if (!doc.isRecurring)
    throw new AppError("CONFLICT", "This expense is not a recurring template");
  doc.isRecurring = false;
  await doc.save();
  return toDTO(doc as unknown as ExpenseDoc);
}
