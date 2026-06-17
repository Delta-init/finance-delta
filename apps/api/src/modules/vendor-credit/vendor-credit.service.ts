import { Types } from "mongoose";
import type { CreateVendorCreditInput, VendorCredit as DTO, ApplyVendorCreditInput, VendorCreditQuery, Paginated } from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { VendorCredit, type VendorCreditDoc } from "./vendor-credit.model";
import { Vendor } from "../vendor/vendor.model";
import { Bill } from "../bill/bill.model";
import { nextNumber } from "../sequence/sequence.service";

function lineTotal(l: { quantity: number; unitPriceMinor: number; discountPct: number; taxPct: number }) {
  const sub = l.quantity * l.unitPriceMinor;
  const disc = Math.round(sub * l.discountPct / 100);
  const taxable = sub - disc;
  return taxable + Math.round(taxable * l.taxPct / 100);
}

function dateOnly(d: Date | undefined): string {
  if (!d) return "";
  return d.toISOString().slice(0, 10);
}

function toDTO(doc: VendorCreditDoc): DTO {
  const d = doc as unknown as Record<string, unknown>;
  return {
    id: doc._id.toString(),
    creditNumber: doc.creditNumber,
    vendorId: String(doc.vendorId),
    vendorName: doc.vendorName,
    sourceBillId: d.sourceBillId ? String(d.sourceBillId) : undefined,
    sourceBillNumber: (d.sourceBillNumber as string) ?? undefined,
    reason: doc.reason,
    issueDate: dateOnly(doc.issueDate as unknown as Date),
    status: doc.status as DTO["status"],
    currency: (doc.currency as string) ?? "AED",
    lineItems: (doc.lineItems as unknown as DTO["lineItems"]),
    subtotalMinor: (doc.subtotalMinor as number) ?? 0,
    taxTotalMinor: (doc.taxTotalMinor as number) ?? 0,
    totalMinor: (doc.totalMinor as number) ?? 0,
    amountAppliedMinor: (doc.amountAppliedMinor as number) ?? 0,
    notes: (doc.notes as string) ?? "",
    issuedAt: doc.issuedAt ? (doc.issuedAt as unknown as Date).toISOString() : undefined,
    createdAt: doc.createdAt.toISOString(),
  };
}

const SORT = {
  number: "creditNumber",
  vendor: "vendorName",
  issue: "issueDate",
  status: "status",
  total: "totalMinor",
  createdAt: "createdAt",
} as const;

export async function listVendorCredits(orgId: string, query: VendorCreditQuery): Promise<Paginated<DTO>> {
  const and: Record<string, unknown>[] = [];
  const or = searchOr(query.q, ["creditNumber", "vendorName", "reason"]);
  if (or) and.push({ $or: or });
  if (query.status) and.push({ status: query.status });
  if (query.vendorId) and.push({ vendorId: new Types.ObjectId(query.vendorId) });

  const filter: Record<string, unknown> = { organizationId: orgId };
  if (and.length) filter.$and = and;

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    VendorCredit.find(filter).sort(sort).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize),
    VendorCredit.countDocuments(filter),
  ]);
  return { data: rows.map((r) => toDTO(r as unknown as VendorCreditDoc)), meta: pageMeta(total, query.page, query.pageSize) };
}

export async function getVendorCredit(orgId: string, id: string): Promise<DTO> {
  const doc = await VendorCredit.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Vendor credit not found");
  return toDTO(doc as unknown as VendorCreditDoc);
}

export async function createVendorCredit(orgId: string, input: CreateVendorCreditInput): Promise<DTO> {
  const vendor = await Vendor.findOne({ _id: input.vendorId, organizationId: orgId });
  if (!vendor) throw new AppError("NOT_FOUND", "Vendor not found");

  let sourceBillNumber: string | undefined;
  if (input.sourceBillId) {
    const bill = await Bill.findOne({ _id: input.sourceBillId, organizationId: orgId });
    if (!bill) throw new AppError("NOT_FOUND", "Source bill not found");
    sourceBillNumber = bill.billNumber;
  }

  const lines = input.lineItems.map((l) => ({ ...l, lineTotalMinor: lineTotal(l) }));
  const subtotalMinor = lines.reduce((s, l) => s + l.quantity * l.unitPriceMinor, 0);
  const taxTotalMinor = lines.reduce((s, l) => {
    const taxable = l.quantity * l.unitPriceMinor - Math.round(l.quantity * l.unitPriceMinor * l.discountPct / 100);
    return s + Math.round(taxable * l.taxPct / 100);
  }, 0);
  const totalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  const creditNumber = await nextNumber(orgId, "vendor-credit", "VCR-");

  const doc = await VendorCredit.create({
    organizationId: new Types.ObjectId(orgId),
    creditNumber,
    vendorId: new Types.ObjectId(input.vendorId),
    vendorName: vendor.name,
    sourceBillId: input.sourceBillId ? new Types.ObjectId(input.sourceBillId) : undefined,
    sourceBillNumber,
    reason: input.reason,
    issueDate: new Date(input.issueDate),
    currency: input.currency ?? (vendor.currency as string) ?? "AED",
    lineItems: lines,
    subtotalMinor,
    taxTotalMinor,
    totalMinor,
    amountAppliedMinor: 0,
    notes: input.notes ?? "",
    status: "draft",
  });
  return toDTO(doc as unknown as VendorCreditDoc);
}

export async function issueVendorCredit(orgId: string, id: string): Promise<DTO> {
  const doc = await VendorCredit.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Vendor credit not found");
  if (doc.status !== "draft") throw new AppError("CONFLICT", "Only draft credits can be issued");
  doc.status = "issued";
  doc.issuedAt = new Date() as unknown as typeof doc.issuedAt;
  await doc.save();
  return toDTO(doc as unknown as VendorCreditDoc);
}

export async function applyVendorCredit(orgId: string, id: string, input: ApplyVendorCreditInput): Promise<DTO> {
  const vc = await VendorCredit.findOne({ _id: id, organizationId: orgId });
  if (!vc) throw new AppError("NOT_FOUND", "Vendor credit not found");
  if (vc.status !== "issued") throw new AppError("CONFLICT", "Credit must be issued before applying");

  const remaining = ((vc.totalMinor as number) ?? 0) - ((vc.amountAppliedMinor as number) ?? 0);
  if (remaining <= 0) throw new AppError("CONFLICT", "Vendor credit has no remaining balance");

  const bill = await Bill.findOne({ _id: input.targetBillId, organizationId: orgId });
  if (!bill) throw new AppError("NOT_FOUND", "Target bill not found");
  if (!["approved", "partially_paid"].includes(bill.status as string))
    throw new AppError("CONFLICT", "Bill must be approved to apply credit");

  const applyAmount = Math.min(remaining, input.amountMinor, (bill.balanceMinor as number) ?? 0);
  if (applyAmount <= 0) throw new AppError("CONFLICT", "Nothing to apply — bill may already be paid");

  bill.balanceMinor = ((bill.balanceMinor as number) ?? 0) - applyAmount;
  bill.amountPaidMinor = ((bill.amountPaidMinor as number) ?? 0) + applyAmount;
  bill.status = bill.balanceMinor <= 0 ? "paid" : "partially_paid";
  await bill.save();

  vc.amountAppliedMinor = ((vc.amountAppliedMinor as number) ?? 0) + applyAmount;
  if ((vc.amountAppliedMinor as number) >= (vc.totalMinor as number)) vc.status = "applied";
  await vc.save();

  return toDTO(vc as unknown as VendorCreditDoc);
}

export async function voidVendorCredit(orgId: string, id: string): Promise<DTO> {
  const doc = await VendorCredit.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Vendor credit not found");
  if (doc.status === "applied") throw new AppError("CONFLICT", "Applied credits cannot be voided");
  doc.status = "voided";
  await doc.save();
  return toDTO(doc as unknown as VendorCreditDoc);
}
