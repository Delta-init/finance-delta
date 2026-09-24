import { Types } from "mongoose";
import type { BudgetQuery, BudgetSummaryRow, CreateFundingRequestInput, FundingRequest, ReviewFundingRequestInput, UpsertBudgetAllocationInput, BudgetAllocation } from "@delta/shared";
import { AppError } from "../../lib/http";
import { Department } from "../department/department.model";
import { Expense } from "../expense/expense.model";
import { User } from "../user/user.model";
import { BudgetAllocationModel, FundingRequestModel } from "./budget.model";

function refId(value: unknown): string { return String(value ?? ""); }

async function userAndDepartment(userId: string, organizationId: string) {
  const user = await User.findOne({ _id: userId, "memberships.organizationId": organizationId }).select("name memberships").lean();
  if (!user) throw new AppError("FORBIDDEN", "Your account is not a member of this organization");
  const membership = user.memberships.find((m) => refId(m.organizationId) === organizationId && m.status === "active");
  if (!membership?.departmentId) throw new AppError("FORBIDDEN", "Your account is not assigned to a department");
  const departmentId = refId(membership.departmentId);
  const department = await Department.findOne({ _id: departmentId, organizationId }).select("name").lean();
  if (!department) throw new AppError("FORBIDDEN", "Your department is not available in this organization");
  return { user, departmentId, departmentName: department.name };
}

function periodBounds(year: number, month?: number) {
  const start = new Date(Date.UTC(year, month ? month - 1 : 0, 1));
  const end = new Date(Date.UTC(year, month ?? 12, 1));
  return { start, end };
}

function allocationDTO(row: any): BudgetAllocation {
  return {
    id: refId(row._id), departmentId: refId(row.departmentId?._id ?? row.departmentId),
    departmentName: row.departmentId?.name ?? "Department", period: row.period, currency: row.currency,
    allocatedMinor: row.allocatedMinor, note: row.note ?? "", updatedByName: row.updatedByName,
    updatedAt: new Date(row.updatedAt).toISOString(),
    changes: (row.changes ?? []).map((change: any) => ({ allocatedMinor: change.allocatedMinor, note: change.note ?? "", changedByName: change.changedByName, changedAt: new Date(change.changedAt).toISOString() })),
  };
}

function requestDTO(row: any): FundingRequest {
  return {
    id: refId(row._id), departmentId: refId(row.departmentId?._id ?? row.departmentId),
    departmentName: row.departmentId?.name ?? "Department", period: row.period, currency: row.currency,
    amountMinor: row.amountMinor, title: row.title, purpose: row.purpose, status: row.status,
    requestedById: refId(row.requestedById), requestedByName: row.requestedByName,
    requestedAt: new Date(row.createdAt).toISOString(), reviewedByName: row.reviewedByName || undefined,
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : undefined, reviewNote: row.reviewNote || undefined,
  };
}

export async function getBudgetSummary(organizationId: string, userId: string, query: BudgetQuery, allDepartments: boolean): Promise<BudgetSummaryRow[]> {
  const year = query.year ?? new Date().getUTCFullYear();
  const selectedMonth = query.month ? Number(query.month.slice(5, 7)) : undefined;
  const { start, end } = periodBounds(year, selectedMonth);
  let departmentIds: Types.ObjectId[];
  if (allDepartments) {
    const departments = await Department.find({ organizationId }).select("_id name").sort({ name: 1 }).lean();
    departmentIds = departments.map((d) => d._id);
  } else {
    const own = await userAndDepartment(userId, organizationId);
    departmentIds = [new Types.ObjectId(own.departmentId)];
  }
  if (query.departmentId && allDepartments) {
    if (!Types.ObjectId.isValid(query.departmentId)) throw new AppError("VALIDATION_ERROR", "Invalid department");
    departmentIds = departmentIds.filter((id) => String(id) === query.departmentId);
  }
  if (!departmentIds.length) return [];
  const orgObjectId = new Types.ObjectId(organizationId);
  const periodFilter = query.month ? query.month : { $gte: `${year}-01`, $lte: `${year}-12` };
  const [departments, allocations, requests, expenses] = await Promise.all([
    Department.find({ _id: { $in: departmentIds }, organizationId }).select("name").lean(),
    BudgetAllocationModel.find({ organizationId: orgObjectId, departmentId: { $in: departmentIds }, period: periodFilter }).lean(),
    FundingRequestModel.aggregate([
      { $match: { organizationId: orgObjectId, departmentId: { $in: departmentIds }, period: periodFilter } },
      { $group: { _id: { departmentId: "$departmentId", period: "$period", currency: "$currency", status: "$status" }, amountMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
    ]),
    Expense.aggregate([
      { $match: { organizationId: orgObjectId, departmentId: { $in: departmentIds }, status: "approved", expenseDate: { $gte: start, $lt: end } } },
      { $group: { _id: { departmentId: "$departmentId", period: { $dateToString: { format: "%Y-%m", date: "$expenseDate", timezone: "UTC" } }, currency: "$currency" }, amountMinor: { $sum: "$totalMinor" } } },
    ]),
  ]);

  const deptNames = new Map(departments.map((d) => [String(d._id), d.name]));
  const rows = new Map<string, BudgetSummaryRow>();
  const ensure = (departmentId: string, period: string, currency: string) => {
    const key = `${departmentId}|${period}|${currency}`;
    let row = rows.get(key);
    if (!row) {
      row = { departmentId, departmentName: deptNames.get(departmentId) ?? "Department", period, currency, allocatedMinor: 0, approvedRequestsMinor: 0, approvedExpensesMinor: 0, availableMinor: 0, pendingRequests: 0 };
      rows.set(key, row);
    }
    return row;
  };
  for (const a of allocations) ensure(String(a.departmentId), a.period, a.currency).allocatedMinor = a.allocatedMinor;
  for (const r of requests) {
    const row = ensure(String(r._id.departmentId), r._id.period, r._id.currency);
    if (r._id.status === "approved") row.approvedRequestsMinor = r.amountMinor;
    if (r._id.status === "submitted") row.pendingRequests += r.count;
  }
  for (const e of expenses) ensure(String(e._id.departmentId), e._id.period, e._id.currency).approvedExpensesMinor = e.amountMinor;
  for (const row of rows.values()) row.availableMinor = row.allocatedMinor + row.approvedRequestsMinor - row.approvedExpensesMinor;
  return [...rows.values()].sort((a, b) => a.period.localeCompare(b.period) || a.departmentName.localeCompare(b.departmentName) || a.currency.localeCompare(b.currency));
}

export async function listAllocations(organizationId: string, year: number, departmentId?: string) {
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(organizationId), period: { $gte: `${year}-01`, $lte: `${year}-12` } };
  if (departmentId) filter.departmentId = new Types.ObjectId(departmentId);
  const rows = await BudgetAllocationModel.find(filter).populate("departmentId", "name").sort({ period: 1 }).lean();
  return rows.map(allocationDTO);
}

export async function upsertAllocation(organizationId: string, userId: string, input: UpsertBudgetAllocationInput) {
  if (!Types.ObjectId.isValid(input.departmentId)) throw new AppError("VALIDATION_ERROR", "Invalid department");
  const [department, user] = await Promise.all([
    Department.findOne({ _id: input.departmentId, organizationId }).select("name"),
    User.findOne({ _id: userId, "memberships.organizationId": organizationId }).select("name"),
  ]);
  if (!department) throw new AppError("VALIDATION_ERROR", "Department not found in this organization");
  if (!user) throw new AppError("FORBIDDEN", "User membership not found");
  const filter = { organizationId: new Types.ObjectId(organizationId), departmentId: department._id, period: input.period, currency: input.currency };
  const update = {
    $set: { allocatedMinor: input.allocatedMinor, note: input.note, updatedById: new Types.ObjectId(userId), updatedByName: user.name },
    $push: { changes: { allocatedMinor: input.allocatedMinor, note: input.note, changedById: new Types.ObjectId(userId), changedByName: user.name, changedAt: new Date() } },
  };
  let row;
  try {
    row = await BudgetAllocationModel.findOneAndUpdate(filter, update, { new: true, upsert: true, setDefaultsOnInsert: true }).populate("departmentId", "name");
  } catch (error) {
    // Two first-time allocations can race on the unique monthly key. Retry as
    // an update so neither save is lost and both revisions remain in the log.
    if ((error as { code?: number }).code !== 11000) throw error;
    row = await BudgetAllocationModel.findOneAndUpdate(filter, update, { new: true }).populate("departmentId", "name");
  }
  return allocationDTO(row!.toObject());
}

export async function createFundingRequest(organizationId: string, userId: string, input: CreateFundingRequestInput) {
  const { user, departmentId, departmentName } = await userAndDepartment(userId, organizationId);
  const row = await FundingRequestModel.create({ organizationId: new Types.ObjectId(organizationId), departmentId: new Types.ObjectId(departmentId), period: input.period, currency: input.currency, amountMinor: input.amountMinor, title: input.title, purpose: input.purpose, requestedById: new Types.ObjectId(userId), requestedByName: user.name, status: "submitted" });
  return requestDTO({ ...row.toObject(), departmentId: { _id: departmentId, name: departmentName } });
}

export async function listFundingRequests(organizationId: string, userId: string, query: BudgetQuery, allDepartments: boolean) {
  const filter: Record<string, unknown> = { organizationId: new Types.ObjectId(organizationId) };
  if (!allDepartments) filter.departmentId = new Types.ObjectId((await userAndDepartment(userId, organizationId)).departmentId);
  if (query.departmentId && allDepartments) filter.departmentId = new Types.ObjectId(query.departmentId);
  if (query.month) filter.period = query.month;
  else if (query.year) filter.period = { $gte: `${query.year}-01`, $lte: `${query.year}-12` };
  const rows = await FundingRequestModel.find(filter).populate("departmentId", "name").sort({ createdAt: -1 }).limit(500).lean();
  return rows.map(requestDTO);
}

export async function reviewFundingRequest(organizationId: string, userId: string, input: ReviewFundingRequestInput, requestId: string) {
  if (!Types.ObjectId.isValid(requestId)) throw new AppError("NOT_FOUND", "Funding request not found");
  const user = await User.findOne({ _id: userId, "memberships.organizationId": organizationId }).select("name").lean();
  if (!user) throw new AppError("FORBIDDEN", "User membership not found");
  const row = await FundingRequestModel.findOneAndUpdate(
    { _id: requestId, organizationId: new Types.ObjectId(organizationId), status: "submitted", requestedById: { $ne: new Types.ObjectId(userId) } },
    { $set: { status: input.decision, reviewedById: new Types.ObjectId(userId), reviewedByName: user.name, reviewedAt: new Date(), reviewNote: input.note } },
    { new: true },
  ).populate("departmentId", "name").lean();
  if (!row) throw new AppError("CONFLICT", "Request is unavailable, already reviewed, or you cannot approve your own request");
  return requestDTO(row);
}
