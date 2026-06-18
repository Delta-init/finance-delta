import { Types } from "mongoose";
import type {
  CreateCommissionStructureInput,
  UpdateCommissionStructureInput,
  CommissionStructure as CommissionStructureDTO,
  CommissionRecord as CommissionRecordDTO,
  CommissionReport,
  CommissionRecordQuery,
  MarkCommissionPaidInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { CommissionStructure, type CommissionStructureDoc } from "./commission-structure.model";
import { CommissionRecord, type CommissionRecordDoc } from "./commission-record.model";
import { User } from "../user/user.model";
import { Invoice } from "../invoice/invoice.model";

// ── Helpers ───────────────────────────────────────────────────────────────────

function oid(id: string) { return new Types.ObjectId(id); }

function dateOnly(d: Date | undefined): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function structureToDTO(doc: CommissionStructureDoc): CommissionStructureDTO {
  const d = doc as unknown as Record<string, unknown>;
  return {
    id: doc._id.toString(),
    salespersonId: String(doc.salespersonId),
    salespersonName: doc.salespersonName,
    type: doc.type as CommissionStructureDTO["type"],
    flatAmountMinor: (doc.flatAmountMinor as number) ?? 0,
    percentage: (doc.percentage as number) ?? 0,
    tiers: (doc.tiers as CommissionStructureDTO["tiers"]) ?? [],
    basis: doc.basis as CommissionStructureDTO["basis"],
    isLocked: (doc.isLocked as boolean) ?? false,
    isActive: (doc.isActive as boolean) ?? true,
    effectiveFrom: dateOnly(doc.effectiveFrom as unknown as Date),
    effectiveTo: d.effectiveTo ? dateOnly(d.effectiveTo as Date) : undefined,
    notes: (doc.notes as string) ?? "",
    lockedByName: (doc.lockedByName as string) || undefined,
    lockedAt: d.lockedAt ? (d.lockedAt as Date).toISOString() : undefined,
    createdAt: doc.createdAt.toISOString(),
  };
}

function recordToDTO(doc: CommissionRecordDoc): CommissionRecordDTO {
  const d = doc as unknown as Record<string, unknown>;
  return {
    id: doc._id.toString(),
    structureId: String(doc.structureId),
    salespersonId: String(doc.salespersonId),
    salespersonName: doc.salespersonName,
    invoiceId: String(doc.invoiceId),
    invoiceNumber: doc.invoiceNumber,
    invoiceTotalMinor: (doc.invoiceTotalMinor as number) ?? 0,
    commissionMinor: (doc.commissionMinor as number) ?? 0,
    basis: doc.basis as CommissionRecordDTO["basis"],
    status: doc.status as CommissionRecordDTO["status"],
    calculatedAt: (d.calculatedAt as Date).toISOString(),
    paidAt: d.paidAt ? (d.paidAt as Date).toISOString() : undefined,
    paidExpenseId: (doc.paidExpenseId as string) || undefined,
    notes: (doc.notes as string) ?? "",
  };
}

// ── Commission calculation ────────────────────────────────────────────────────

function calculateCommission(
  structure: CommissionStructureDoc,
  invoiceTotalMinor: number,
): number {
  const type = structure.type as string;
  if (type === "flat") return (structure.flatAmountMinor as number) ?? 0;
  if (type === "percentage") {
    const pct = (structure.percentage as number) ?? 0;
    return Math.round((invoiceTotalMinor * pct) / 100);
  }
  if (type === "tiered") {
    const tiers = (structure.tiers as { upToMinor: number | null; percentage: number }[]) ?? [];
    const sorted = [...tiers].sort((a, b) => {
      if (a.upToMinor === null) return 1;
      if (b.upToMinor === null) return -1;
      return a.upToMinor - b.upToMinor;
    });
    // Step method: full invoice amount × rate of the matching tier
    for (const tier of sorted) {
      if (tier.upToMinor === null || invoiceTotalMinor <= tier.upToMinor) {
        return Math.round((invoiceTotalMinor * tier.percentage) / 100);
      }
    }
    // Fallback: highest tier if none matched (shouldn't happen with a null-capped tier)
    const last = sorted[sorted.length - 1];
    return last ? Math.round((invoiceTotalMinor * last.percentage) / 100) : 0;
  }
  return 0;
}

// ── Auto-calculate (called from invoice hooks) ────────────────────────────────

export async function autoCalculate(
  orgId: string,
  invoiceId: string,
  basis: "invoice_raised" | "payment_received",
): Promise<void> {
  const invoice = await Invoice.findOne({ _id: oid(invoiceId), organizationId: oid(orgId) }).lean();
  if (!invoice) return;

  const d = invoice as unknown as Record<string, unknown>;
  const salespersonId = String(d.salespersonId);

  const structure = await CommissionStructure.findOne({
    organizationId: oid(orgId),
    salespersonId: oid(salespersonId),
    basis,
    isActive: true,
  }).lean();
  if (!structure) return;

  const invoiceTotalMinor = (invoice.totalMinor as number) ?? 0;
  const commissionMinor = calculateCommission(
    structure as unknown as CommissionStructureDoc,
    invoiceTotalMinor,
  );
  if (commissionMinor === 0) return;

  // Upsert — one record per invoice + basis combination (unique index)
  await CommissionRecord.findOneAndUpdate(
    { organizationId: oid(orgId), invoiceId: oid(invoiceId), basis },
    {
      $setOnInsert: {
        organizationId: oid(orgId),
        structureId: (structure as unknown as CommissionStructureDoc)._id,
        salespersonId: oid(salespersonId),
        salespersonName: (invoice as unknown as Record<string, unknown>).salespersonName as string,
        invoiceId: oid(invoiceId),
        invoiceNumber: invoice.invoiceNumber,
        invoiceTotalMinor,
        commissionMinor,
        basis,
        status: "earned",
        calculatedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );
}

// ── Commission structures ─────────────────────────────────────────────────────

export async function listStructures(orgId: string): Promise<CommissionStructureDTO[]> {
  const docs = await CommissionStructure.find({ organizationId: oid(orgId) })
    .sort({ createdAt: -1 })
    .lean();
  return (docs as unknown as CommissionStructureDoc[]).map(structureToDTO);
}

export async function getStructure(orgId: string, id: string): Promise<CommissionStructureDTO> {
  const doc = await CommissionStructure.findOne({ _id: oid(id), organizationId: oid(orgId) }).lean();
  if (!doc) throw new AppError("NOT_FOUND", "Commission structure not found");
  return structureToDTO(doc as unknown as CommissionStructureDoc);
}

export async function createStructure(
  orgId: string,
  input: CreateCommissionStructureInput,
  createdById: string,
): Promise<CommissionStructureDTO> {
  const user = await User.findOne({ _id: oid(input.salespersonId), organizationId: oid(orgId) }).lean();
  if (!user) throw new AppError("NOT_FOUND", "Salesperson not found");

  const doc = await CommissionStructure.create({
    organizationId: oid(orgId),
    salespersonId: oid(input.salespersonId),
    salespersonName: (user as unknown as { name: string }).name,
    type: input.type,
    flatAmountMinor: input.flatAmountMinor ?? 0,
    percentage: input.percentage ?? 0,
    tiers: input.tiers ?? [],
    basis: input.basis,
    effectiveFrom: new Date(input.effectiveFrom),
    effectiveTo: input.effectiveTo ? new Date(input.effectiveTo) : undefined,
    notes: input.notes,
    isLocked: false,
    isActive: true,
    createdById: oid(createdById),
  });
  return structureToDTO(doc as unknown as CommissionStructureDoc);
}

export async function updateStructure(
  orgId: string,
  id: string,
  input: UpdateCommissionStructureInput,
  actorId: string,
  actorPermissions: string[],
): Promise<CommissionStructureDTO> {
  const doc = await CommissionStructure.findOne({ _id: oid(id), organizationId: oid(orgId) });
  if (!doc) throw new AppError("NOT_FOUND", "Commission structure not found");

  const d = doc as unknown as Record<string, unknown>;
  if ((d.isLocked as boolean) && !actorPermissions.includes("commission:approve") && !actorPermissions.includes("*")) {
    throw new AppError("FORBIDDEN", "Structure is locked. Only admins with commission:approve can edit it.");
  }

  if (input.salespersonId && input.salespersonId !== String(d.salespersonId)) {
    const user = await User.findOne({ _id: oid(input.salespersonId), organizationId: oid(orgId) }).lean();
    if (!user) throw new AppError("NOT_FOUND", "Salesperson not found");
    (doc as unknown as Record<string, unknown>).salespersonId = oid(input.salespersonId);
    (doc as unknown as Record<string, unknown>).salespersonName = (user as unknown as { name: string }).name;
  }

  if (input.type !== undefined) (doc as unknown as Record<string, unknown>).type = input.type;
  if (input.flatAmountMinor !== undefined) (doc as unknown as Record<string, unknown>).flatAmountMinor = input.flatAmountMinor;
  if (input.percentage !== undefined) (doc as unknown as Record<string, unknown>).percentage = input.percentage;
  if (input.tiers !== undefined) (doc as unknown as Record<string, unknown>).tiers = input.tiers;
  if (input.basis !== undefined) (doc as unknown as Record<string, unknown>).basis = input.basis;
  if (input.effectiveFrom !== undefined) (doc as unknown as Record<string, unknown>).effectiveFrom = new Date(input.effectiveFrom);
  if (input.effectiveTo !== undefined) (doc as unknown as Record<string, unknown>).effectiveTo = new Date(input.effectiveTo);
  if (input.notes !== undefined) (doc as unknown as Record<string, unknown>).notes = input.notes;
  if (input.isActive !== undefined) (doc as unknown as Record<string, unknown>).isActive = input.isActive;

  await doc.save();
  return structureToDTO(doc as unknown as CommissionStructureDoc);
}

export async function toggleLock(
  orgId: string,
  id: string,
  lock: boolean,
  actorId: string,
  actorName: string,
): Promise<CommissionStructureDTO> {
  const doc = await CommissionStructure.findOne({ _id: oid(id), organizationId: oid(orgId) });
  if (!doc) throw new AppError("NOT_FOUND", "Commission structure not found");

  const d = doc as unknown as Record<string, unknown>;
  d.isLocked = lock;
  if (lock) {
    d.lockedById = oid(actorId);
    d.lockedByName = actorName;
    d.lockedAt = new Date();
  } else {
    d.lockedById = undefined;
    d.lockedByName = "";
    d.lockedAt = undefined;
  }
  await doc.save();
  return structureToDTO(doc as unknown as CommissionStructureDoc);
}

// ── Commission records ────────────────────────────────────────────────────────

export async function listRecords(
  orgId: string,
  query: CommissionRecordQuery,
): Promise<{ data: CommissionRecordDTO[]; meta: { total: number; page: number; pageSize: number; pageCount: number } }> {
  const filter: Record<string, unknown> = { organizationId: oid(orgId) };
  if (query.salespersonId) filter.salespersonId = oid(query.salespersonId);
  if (query.status) filter.status = query.status;
  if (query.from || query.to) {
    const dateFilter: Record<string, Date> = {};
    if (query.from) dateFilter.$gte = new Date(`${query.from}T00:00:00.000Z`);
    if (query.to) dateFilter.$lte = new Date(`${query.to}T23:59:59.999Z`);
    filter.calculatedAt = dateFilter;
  }

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  const skip = (page - 1) * pageSize;

  const [docs, total] = await Promise.all([
    CommissionRecord.find(filter).sort({ calculatedAt: -1 }).skip(skip).limit(pageSize).lean(),
    CommissionRecord.countDocuments(filter),
  ]);

  return {
    data: (docs as unknown as CommissionRecordDoc[]).map(recordToDTO),
    meta: { total, page, pageSize, pageCount: Math.ceil(total / pageSize) },
  };
}

export async function markPaid(
  orgId: string,
  input: MarkCommissionPaidInput,
): Promise<{ updated: number }> {
  const ids = input.recordIds.map(oid);
  const paidAt = input.paidAt ? new Date(input.paidAt) : new Date();
  const result = await CommissionRecord.updateMany(
    { _id: { $in: ids }, organizationId: oid(orgId), status: "earned" },
    {
      $set: {
        status: "paid",
        paidAt,
        paidExpenseId: input.expenseId ?? "",
        notes: input.notes,
      },
    },
  );
  return { updated: result.modifiedCount };
}

export async function cancelRecord(orgId: string, id: string): Promise<CommissionRecordDTO> {
  const doc = await CommissionRecord.findOneAndUpdate(
    { _id: oid(id), organizationId: oid(orgId), status: "earned" },
    { $set: { status: "cancelled" } },
    { new: true },
  );
  if (!doc) throw new AppError("NOT_FOUND", "Commission record not found or already processed");
  return recordToDTO(doc as unknown as CommissionRecordDoc);
}

// ── Commission report ─────────────────────────────────────────────────────────

export async function getCommissionReport(
  orgId: string,
  from: string,
  to: string,
  currency = "AED",
): Promise<CommissionReport> {
  const agg = await CommissionRecord.aggregate([
    {
      $match: {
        organizationId: oid(orgId),
        status: { $ne: "cancelled" },
        calculatedAt: {
          $gte: new Date(`${from}T00:00:00.000Z`),
          $lte: new Date(`${to}T23:59:59.999Z`),
        },
      },
    },
    {
      $group: {
        _id: { salespersonId: "$salespersonId", salespersonName: "$salespersonName" },
        earnedMinor: { $sum: { $cond: [{ $ne: ["$status", "paid"] }, "$commissionMinor", 0] } },
        paidMinor: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$commissionMinor", 0] } },
        invoiceCount: { $sum: 1 },
      },
    },
    { $sort: { "_id.salespersonName": 1 } },
  ]);

  const rows = agg.map((a: { _id: { salespersonId: Types.ObjectId; salespersonName: string }; earnedMinor: number; paidMinor: number; invoiceCount: number }) => ({
    salespersonId: a._id.salespersonId.toString(),
    salespersonName: a._id.salespersonName,
    earnedMinor: a.earnedMinor,
    paidMinor: a.paidMinor,
    pendingMinor: a.earnedMinor,  // pending = earned but not yet paid
    invoiceCount: a.invoiceCount,
  }));

  const totals = rows.reduce(
    (acc, r) => ({
      earnedMinor: acc.earnedMinor + r.earnedMinor + r.paidMinor,
      paidMinor: acc.paidMinor + r.paidMinor,
      pendingMinor: acc.pendingMinor + r.earnedMinor,
    }),
    { earnedMinor: 0, paidMinor: 0, pendingMinor: 0 },
  );

  return { from, to, currency, rows, totals };
}
