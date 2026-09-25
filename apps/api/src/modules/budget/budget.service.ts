import { Types } from "mongoose";
import type { BudgetQuery, BudgetSummaryRow, CreateFundingRequestInput, FundingRequest, InboundFundingRequest, ReviewFundingRequestInput, UpsertBudgetAllocationInput, BudgetAllocation } from "@delta/shared";
import { AppError } from "../../lib/http";
import { Department } from "../department/department.model";
import { Expense } from "../expense/expense.model";
import { User } from "../user/user.model";
import { BudgetAllocationModel, FundingRequestModel } from "./budget.model";
import { notifyFundingApprovers } from "./budget-notify.service";

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
    kind: row.kind === "drawdown" ? "drawdown" : "topup", source: row.external?.source || "finance", platform: row.platform ?? "",
    requestedById: refId(row.requestedById), requestedByName: row.requestedByName, requestedByEmail: row.requestedByEmail || undefined,
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
      // Rows from before drawdowns existed carry no kind, and were all top-ups.
      { $group: { _id: { departmentId: "$departmentId", period: "$period", currency: "$currency", status: "$status", kind: { $ifNull: ["$kind", "topup"] } }, amountMinor: { $sum: "$amountMinor" }, count: { $sum: 1 } } },
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
      row = { departmentId, departmentName: deptNames.get(departmentId) ?? "Department", period, currency, allocatedMinor: 0, approvedRequestsMinor: 0, approvedDrawdownsMinor: 0, approvedExpensesMinor: 0, availableMinor: 0, pendingRequests: 0 };
      rows.set(key, row);
    }
    return row;
  };
  for (const a of allocations) ensure(String(a.departmentId), a.period, a.currency).allocatedMinor = a.allocatedMinor;
  for (const r of requests) {
    const row = ensure(String(r._id.departmentId), r._id.period, r._id.currency);
    if (r._id.status === "approved") {
      if (r._id.kind === "drawdown") row.approvedDrawdownsMinor += r.amountMinor;
      else row.approvedRequestsMinor += r.amountMinor;
    }
    if (r._id.status === "submitted") row.pendingRequests += r.count;
  }
  for (const e of expenses) ensure(String(e._id.departmentId), e._id.period, e._id.currency).approvedExpensesMinor = e.amountMinor;
  for (const row of rows.values()) row.availableMinor = row.allocatedMinor + row.approvedRequestsMinor - row.approvedDrawdownsMinor - row.approvedExpensesMinor;
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

/**
 * What one department has left in one month, in one currency.
 *
 * The summary's own arithmetic rather than a second copy of it, so the figure
 * an approval is refused on is the figure the Budgets page shows.
 */
async function monthAvailable(organizationId: string, departmentId: string, period: string, currency: string): Promise<number> {
  const rows = await getBudgetSummary(organizationId, "", { year: Number(period.slice(0, 4)), month: period, departmentId }, true);
  return rows.find((row) => row.currency === currency)?.availableMinor ?? 0;
}

function money(minor: number, currency: string): string {
  return `${currency} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function monthName(period: string): string {
  return new Date(`${period}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function overBudget(departmentName: string, period: string, currency: string, availableMinor: number, amountMinor: number): AppError {
  const left = availableMinor > 0 ? `has ${money(availableMinor, currency)} left` : "has nothing left";
  return new AppError(
    "CONFLICT",
    `${departmentName} ${left} for ${monthName(period)}, and this request is ${money(amountMinor, currency)}. Raise the allocation first, or reject the request.`,
  );
}

export async function reviewFundingRequest(organizationId: string, userId: string, input: ReviewFundingRequestInput, requestId: string) {
  if (!Types.ObjectId.isValid(requestId)) throw new AppError("NOT_FOUND", "Funding request not found");
  const user = await User.findOne({ _id: userId, "memberships.organizationId": organizationId }).select("name").lean();
  if (!user) throw new AppError("FORBIDDEN", "User membership not found");
  const orgObjectId = new Types.ObjectId(organizationId);

  /*
   * A drawdown spends the department's allocation, so it may not spend more
   * than is left of it. Checked before the approval is written and again
   * after: two approvals against the same month can each fit on their own and
   * together overspend it, and whichever finds the month overdrawn afterwards
   * puts its own request back rather than leaving the overspend standing.
   */
  const pending = await FundingRequestModel.findOne({ _id: requestId, organizationId: orgObjectId, status: "submitted" }).populate("departmentId", "name").lean();
  const guarded = input.decision === "approved" && pending?.kind === "drawdown";
  const guard = guarded && pending ? {
    departmentId: refId((pending.departmentId as any)?._id ?? pending.departmentId),
    departmentName: (pending.departmentId as any)?.name ?? "The department",
    period: pending.period, currency: pending.currency, amountMinor: pending.amountMinor,
  } : null;
  if (guard) {
    const available = await monthAvailable(organizationId, guard.departmentId, guard.period, guard.currency);
    if (guard.amountMinor > available) throw overBudget(guard.departmentName, guard.period, guard.currency, available, guard.amountMinor);
  }

  const reviewedAt = new Date();
  const row = await FundingRequestModel.findOneAndUpdate(
    { _id: requestId, organizationId: orgObjectId, status: "submitted", requestedById: { $ne: new Types.ObjectId(userId) } },
    { $set: { status: input.decision, reviewedById: new Types.ObjectId(userId), reviewedByName: user.name, reviewedAt, reviewNote: input.note } },
    { new: true },
  ).populate("departmentId", "name").lean();
  if (!row) throw new AppError("CONFLICT", "Request is unavailable, already reviewed, or you cannot approve your own request");

  if (guard) {
    const after = await monthAvailable(organizationId, guard.departmentId, guard.period, guard.currency);
    if (after < 0) {
      await FundingRequestModel.updateOne(
        { _id: row._id, status: "approved", reviewedById: new Types.ObjectId(userId), reviewedAt },
        { $set: { status: "submitted", reviewNote: "" }, $unset: { reviewedById: 1, reviewedByName: 1, reviewedAt: 1 } },
      );
      throw overBudget(guard.departmentName, guard.period, guard.currency, after + guard.amountMinor, guard.amountMinor);
    }
  }
  return requestDTO(row);
}

/**
 * A fund request handed over by another system — Media ERP asking for ad spend
 * against Marketing's allocation. Always a drawdown, always waiting for review.
 *
 * Idempotent on the caller's own id: the case this is built for is a retry
 * after a timeout, which must return the request already made rather than put
 * a second one in front of an approver.
 */
export async function intakeFundingRequest(organizationId: string, input: InboundFundingRequest): Promise<FundingRequest> {
  // The unique key on the caller's id is what makes a retry safe, and Mongoose
  // builds it in the background after start-up. Wait for it (a no-op once
  // built), so the first deliveries after a deploy cannot slip in twice.
  await FundingRequestModel.init();
  const orgObjectId = new Types.ObjectId(organizationId);
  const department = await Department.findOne({ _id: input.departmentId, organizationId }).select("name").lean();
  if (!department) throw new AppError("VALIDATION_ERROR", "Department not found in this organization");

  const key = { organizationId: orgObjectId, "external.source": input.source, "external.externalId": input.externalId };
  const existing = await FundingRequestModel.findOne(key).populate("departmentId", "name").lean();
  if (existing) return requestDTO(existing);

  let row;
  try {
    row = await FundingRequestModel.create({
      organizationId: orgObjectId, departmentId: department._id, period: input.period, currency: input.currency,
      amountMinor: input.amountMinor, title: input.title, purpose: input.purpose, platform: input.platform,
      kind: "drawdown", status: "submitted", external: { source: input.source, externalId: input.externalId },
      requestedByName: input.requestedBy.name, requestedByEmail: input.requestedBy.email,
    });
  } catch (error) {
    // Two deliveries of the same request can race past the lookup above; the
    // unique key lets exactly one in, and the other gets the one that won.
    if ((error as { code?: number }).code !== 11000) throw error;
    const raced = await FundingRequestModel.findOne(key).populate("departmentId", "name").lean();
    if (!raced) throw error;
    return requestDTO(raced);
  }

  const dto = requestDTO({ ...row.toObject(), departmentId: { _id: department._id, name: department.name } });
  // Nobody in finance would otherwise know it arrived: the requester has no
  // login here to chase it with.
  void notifyFundingApprovers(organizationId, dto);
  return dto;
}

/** What became of the requests a calling system handed over, by its own ids. */
export async function fundingRequestStatuses(organizationId: string, source: string, externalIds: string[]) {
  const rows = await FundingRequestModel.find({
    organizationId: new Types.ObjectId(organizationId),
    "external.source": source,
    "external.externalId": { $in: externalIds },
  }).select("external status amountMinor currency period reviewedByName reviewedAt reviewNote").lean();
  return rows.map((row) => ({
    externalId: row.external?.externalId ?? "",
    id: refId(row._id),
    status: row.status,
    amountMinor: row.amountMinor,
    currency: row.currency,
    period: row.period,
    reviewedByName: row.reviewedByName ?? "",
    reviewedAt: row.reviewedAt ? new Date(row.reviewedAt).toISOString() : "",
    reviewNote: row.reviewNote ?? "",
  }));
}
