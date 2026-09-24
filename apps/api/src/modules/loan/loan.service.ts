import { Types } from "mongoose";
import type {
  CreateLoanInput,
  UpdateLoanInput,
  RecordRepaymentInput,
  LoanQuery,
  Loan as LoanDTO,
  LoanRepayment as LoanRepaymentDTO,
  LoanSummaryReport,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { Loan, type LoanDoc } from "./loan.model";
import { LoanRepayment, type LoanRepaymentDoc } from "./loan-repayment.model";

function oid(id: string) { return new Types.ObjectId(id); }

// ── Interest calculation ──────────────────────────────────────────────────────

function daysBetween(from: string, to: string): number {
  const a = new Date(from).getTime();
  const b = new Date(to).getTime();
  return Math.max(0, Math.floor((b - a) / 86_400_000));
}

function computeAccruedInterest(
  doc: LoanDoc,
  outstandingPrincipalMinor: number,
  totalRepaidInterestMinor: number,
): number {
  if (doc.status === "closed") return 0;
  const rate = (doc.interestRate as number) ?? 0;
  if (rate === 0 || outstandingPrincipalMinor <= 0) return 0;

  const today = new Date().toISOString().slice(0, 10);
  const days = daysBetween(doc.startDate as string, today);
  if (days === 0) return 0;

  let totalAccrued: number;
  if ((doc.interestType as string) === "compound") {
    // Monthly compound: P × ((1 + r/1200)^n - 1)
    const months = days / 30.44;
    totalAccrued = Math.round(
      (doc.principalMinor as number) * (Math.pow(1 + rate / 1200, months) - 1),
    );
  } else {
    // Simple: P × r × t / 36500
    totalAccrued = Math.round((outstandingPrincipalMinor * rate * days) / 36500);
  }

  return Math.max(0, totalAccrued - totalRepaidInterestMinor);
}

// ── Auto-number ───────────────────────────────────────────────────────────────

async function nextLoanNumber(orgId: string): Promise<string> {
  const last = await Loan.findOne({ organizationId: oid(orgId) })
    .sort({ createdAt: -1 })
    .select("loanNumber")
    .lean();
  if (!last) return "LOAN-00001";
  const num = parseInt((last.loanNumber as string).replace("LOAN-", ""), 10) || 0;
  return `LOAN-${String(num + 1).padStart(5, "0")}`;
}

// ── DTO mappers ───────────────────────────────────────────────────────────────

async function loanToDTO(
  doc: LoanDoc,
  repayments?: LoanRepaymentDoc[],
): Promise<LoanDTO> {
  const reps = repayments ?? [];
  const totalRepaidPrincipalMinor = reps.reduce((s, r) => s + ((r.principalMinor as number) ?? 0), 0);
  const totalRepaidInterestMinor = reps.reduce((s, r) => s + ((r.interestMinor as number) ?? 0), 0);
  const outstandingPrincipalMinor = Math.max(0, (doc.principalMinor as number) - totalRepaidPrincipalMinor);
  const accruedInterestMinor = computeAccruedInterest(doc, outstandingPrincipalMinor, totalRepaidInterestMinor);
  const netOwedMinor = outstandingPrincipalMinor + accruedInterestMinor;
  const d = doc as unknown as Record<string, unknown>;

  return {
    id: doc._id.toString(),
    loanNumber: doc.loanNumber as string,
    type: doc.type as LoanDTO["type"],
    counterpartyName: doc.counterpartyName as string,
    counterpartyType: (doc.counterpartyType as LoanDTO["counterpartyType"]) ?? "other",
    counterpartyId: d.counterpartyId ? String(d.counterpartyId) : undefined,
    principalMinor: doc.principalMinor as number,
    interestRate: (doc.interestRate as number) ?? 0,
    interestType: (doc.interestType as LoanDTO["interestType"]) ?? "simple",
    startDate: doc.startDate as string,
    dueDate: (d.dueDate as string) || undefined,
    repaymentFrequency: (doc.repaymentFrequency as LoanDTO["repaymentFrequency"]) ?? "monthly",
    status: doc.status as LoanDTO["status"],
    notes: (doc.notes as string) ?? "",
    totalRepaidPrincipalMinor,
    totalRepaidInterestMinor,
    outstandingPrincipalMinor,
    accruedInterestMinor,
    netOwedMinor,
    createdAt: doc.createdAt.toISOString(),
  };
}

function repaymentToDTO(doc: LoanRepaymentDoc): LoanRepaymentDTO {
  return {
    id: doc._id.toString(),
    loanId: String(doc.loanId),
    paidOn: doc.paidOn as string,
    principalMinor: (doc.principalMinor as number) ?? 0,
    interestMinor: (doc.interestMinor as number) ?? 0,
    totalMinor: ((doc.principalMinor as number) ?? 0) + ((doc.interestMinor as number) ?? 0),
    notes: (doc.notes as string) ?? "",
    createdAt: doc.createdAt.toISOString(),
  };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function createLoan(
  orgId: string,
  input: CreateLoanInput,
  userId: string,
): Promise<LoanDTO> {
  const loanNumber = await nextLoanNumber(orgId);
  const doc = await Loan.create({
    organizationId: oid(orgId),
    loanNumber,
    type: input.type,
    counterpartyName: input.counterpartyName,
    counterpartyType: input.counterpartyType,
    counterpartyId: input.counterpartyId ? oid(input.counterpartyId) : undefined,
    principalMinor: input.principalMinor,
    interestRate: input.interestRate,
    interestType: input.interestType,
    startDate: input.startDate,
    dueDate: input.dueDate,
    repaymentFrequency: input.repaymentFrequency,
    notes: input.notes,
    status: "active",
    createdById: oid(userId),
  });
  return loanToDTO(doc as unknown as LoanDoc, []);
}

export async function getLoan(orgId: string, id: string): Promise<LoanDTO> {
  const doc = await Loan.findOne({ _id: oid(id), organizationId: oid(orgId) }).lean();
  if (!doc) throw new AppError("NOT_FOUND", "Loan not found");
  const repayments = await LoanRepayment.find({
    loanId: oid(id),
    organizationId: oid(orgId),
  }).sort({ paidOn: 1 }).lean();
  return loanToDTO(doc as unknown as LoanDoc, repayments as unknown as LoanRepaymentDoc[]);
}

export async function listLoans(
  orgId: string,
  query: LoanQuery,
): Promise<{ data: LoanDTO[]; meta: { total: number; page: number; pageSize: number; pageCount: number } }> {
  const filter: Record<string, unknown> = { organizationId: oid(orgId) };
  if (query.type) filter.type = query.type;
  if (query.status) filter.status = query.status;

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  const skip = (page - 1) * pageSize;

  const [docs, total] = await Promise.all([
    Loan.find(filter).sort({ createdAt: -1 }).skip(skip).limit(pageSize).lean(),
    Loan.countDocuments(filter),
  ]);

  // Fetch all repayments in one query to avoid N+1
  const loanIds = (docs as unknown as LoanDoc[]).map((d) => d._id);
  const allRepayments = await LoanRepayment.find({
    organizationId: oid(orgId),
    loanId: { $in: loanIds },
  }).lean();

  const repByLoan = new Map<string, LoanRepaymentDoc[]>();
  for (const r of allRepayments as unknown as LoanRepaymentDoc[]) {
    const key = String(r.loanId);
    if (!repByLoan.has(key)) repByLoan.set(key, []);
    repByLoan.get(key)!.push(r);
  }

  const data = await Promise.all(
    (docs as unknown as LoanDoc[]).map((d) =>
      loanToDTO(d, repByLoan.get(d._id.toString()) ?? []),
    ),
  );

  return { data, meta: { total, page, pageSize, pageCount: Math.ceil(total / pageSize) } };
}

export async function updateLoan(
  orgId: string,
  id: string,
  input: UpdateLoanInput,
): Promise<LoanDTO> {
  const doc = await Loan.findOne({ _id: oid(id), organizationId: oid(orgId) });
  if (!doc) throw new AppError("NOT_FOUND", "Loan not found");
  const repaid = await LoanRepayment.aggregate([
    { $match: { loanId: oid(id), organizationId: oid(orgId) } },
    { $group: { _id: null, principal: { $sum: "$principalMinor" } } },
  ]);
  if (input.principalMinor !== undefined && input.principalMinor < (repaid[0]?.principal ?? 0)) {
    throw new AppError("VALIDATION_ERROR", "Principal cannot be less than principal already repaid");
  }
  const d = doc as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) d[key] = value;
  }
  await doc.save();

  const repayments = await LoanRepayment.find({ loanId: oid(id), organizationId: oid(orgId) }).lean();
  return loanToDTO(doc as unknown as LoanDoc, repayments as unknown as LoanRepaymentDoc[]);
}

export async function deleteLoan(orgId: string, id: string): Promise<void> {
  const filter = { _id: oid(id), organizationId: oid(orgId) };
  const doc = await Loan.findOne(filter);
  if (!doc) throw new AppError("NOT_FOUND", "Loan not found");
  const repaymentCount = await LoanRepayment.countDocuments({ loanId: oid(id), organizationId: oid(orgId) });
  if (repaymentCount > 0) {
    throw new AppError("VALIDATION_ERROR", "This loan has repayment history and cannot be deleted");
  }
  await doc.deleteOne();
}

// ── Repayments ────────────────────────────────────────────────────────────────

export async function recordRepayment(
  orgId: string,
  loanId: string,
  input: RecordRepaymentInput,
  userId: string,
): Promise<LoanRepaymentDTO> {
  const loan = await Loan.findOne({ _id: oid(loanId), organizationId: oid(orgId) });
  if (!loan) throw new AppError("NOT_FOUND", "Loan not found");
  if ((loan as unknown as Record<string, unknown>).status === "closed") {
    throw new AppError("VALIDATION_ERROR", "Cannot add repayment to a closed loan");
  }

  const repDoc = await LoanRepayment.create({
    organizationId: oid(orgId),
    loanId: oid(loanId),
    paidOn: input.paidOn,
    principalMinor: input.principalMinor,
    interestMinor: input.interestMinor,
    notes: input.notes,
    createdById: oid(userId),
  });

  // Auto-close if principal is fully repaid
  const totalPrincipalPaid = await LoanRepayment.aggregate([
    { $match: { loanId: oid(loanId), organizationId: oid(orgId) } },
    { $group: { _id: null, total: { $sum: "$principalMinor" } } },
  ]);
  const paid = totalPrincipalPaid[0]?.total ?? 0;
  if (paid >= (loan as unknown as { principalMinor: number }).principalMinor) {
    (loan as unknown as Record<string, unknown>).status = "closed";
    await loan.save();
  }

  return repaymentToDTO(repDoc as unknown as LoanRepaymentDoc);
}

export async function listRepayments(orgId: string, loanId: string): Promise<LoanRepaymentDTO[]> {
  const docs = await LoanRepayment.find({
    loanId: oid(loanId),
    organizationId: oid(orgId),
  }).sort({ paidOn: 1 }).lean();
  return (docs as unknown as LoanRepaymentDoc[]).map(repaymentToDTO);
}

export async function deleteRepayment(orgId: string, repaymentId: string): Promise<void> {
  const doc = await LoanRepayment.findOneAndDelete({ _id: oid(repaymentId), organizationId: oid(orgId) });
  if (!doc) throw new AppError("NOT_FOUND", "Repayment not found");
}

// ── Summary report ────────────────────────────────────────────────────────────

export async function getLoanSummaryReport(orgId: string): Promise<LoanSummaryReport> {
  const allLoans = await Loan.find({ organizationId: oid(orgId) }).lean();
  const loanIds = (allLoans as unknown as LoanDoc[]).map((d) => d._id);

  const allRepayments = await LoanRepayment.find({
    organizationId: oid(orgId),
    loanId: { $in: loanIds },
  }).lean();

  const repByLoan = new Map<string, LoanRepaymentDoc[]>();
  for (const r of allRepayments as unknown as LoanRepaymentDoc[]) {
    const key = String(r.loanId);
    if (!repByLoan.has(key)) repByLoan.set(key, []);
    repByLoan.get(key)!.push(r);
  }

  const dtos = await Promise.all(
    (allLoans as unknown as LoanDoc[]).map((d) =>
      loanToDTO(d, repByLoan.get(d._id.toString()) ?? []),
    ),
  );

  const taken = dtos.filter((l) => l.type === "taken");
  const given = dtos.filter((l) => l.type === "given");

  const sum = (arr: LoanDTO[], key: keyof LoanDTO) =>
    arr.reduce((s, l) => s + ((l[key] as number) ?? 0), 0);

  const statusGroups = ["active", "closed", "defaulted"].map((status) => {
    const group = dtos.filter((l) => l.status === status);
    return {
      status,
      count: group.length,
      outstandingMinor: sum(group, "outstandingPrincipalMinor"),
    };
  });

  return {
    asOf: new Date().toISOString().slice(0, 10),
    taken: {
      count: taken.length,
      principalMinor: sum(taken, "principalMinor"),
      outstandingMinor: sum(taken, "outstandingPrincipalMinor"),
      interestAccruedMinor: sum(taken, "accruedInterestMinor"),
    },
    given: {
      count: given.length,
      principalMinor: sum(given, "principalMinor"),
      outstandingMinor: sum(given, "outstandingPrincipalMinor"),
      interestAccruedMinor: sum(given, "accruedInterestMinor"),
    },
    byStatus: statusGroups,
    loans: dtos,
  };
}
