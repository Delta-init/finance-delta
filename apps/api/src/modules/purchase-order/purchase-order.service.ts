import { Types } from "mongoose";
import type { CreatePOInput, UpdatePOInput, PurchaseOrder as PODTO, POQuery, Paginated } from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { PurchaseOrder, type PurchaseOrderDoc } from "./purchase-order.model";
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

function toDTO(doc: PurchaseOrderDoc): PODTO {
  const d = doc as unknown as Record<string, unknown>;
  return {
    id: doc._id.toString(),
    poNumber: doc.poNumber,
    vendorId: String(doc.vendorId),
    vendorName: doc.vendorName,
    issueDate: dateOnly(doc.issueDate as unknown as Date),
    expectedDate: doc.expectedDate ? dateOnly(doc.expectedDate as unknown as Date) : undefined,
    status: doc.status as PODTO["status"],
    currency: (doc.currency as string) ?? "AED",
    lineItems: (doc.lineItems as unknown as PODTO["lineItems"]),
    subtotalMinor: (doc.subtotalMinor as number) ?? 0,
    taxTotalMinor: (doc.taxTotalMinor as number) ?? 0,
    totalMinor: (doc.totalMinor as number) ?? 0,
    notes: (doc.notes as string) ?? "",
    sourceBillId: d.sourceBillId ? String(d.sourceBillId) : undefined,
    createdAt: doc.createdAt.toISOString(),
  };
}

const SORT = {
  number: "poNumber",
  vendor: "vendorName",
  issue: "issueDate",
  expected: "expectedDate",
  status: "status",
  total: "totalMinor",
  createdAt: "createdAt",
} as const;

export async function listPOs(orgId: string, query: POQuery): Promise<Paginated<PODTO>> {
  const and: Record<string, unknown>[] = [];
  const or = searchOr(query.q, ["poNumber", "vendorName"]);
  if (or) and.push({ $or: or });
  if (query.status) and.push({ status: query.status });
  if (query.vendorId) and.push({ vendorId: new Types.ObjectId(query.vendorId) });

  const filter: Record<string, unknown> = { organizationId: orgId };
  if (and.length) filter.$and = and;

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    PurchaseOrder.find(filter).sort(sort).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize),
    PurchaseOrder.countDocuments(filter),
  ]);
  return { data: rows.map((r) => toDTO(r as unknown as PurchaseOrderDoc)), meta: pageMeta(total, query.page, query.pageSize) };
}

export async function getPO(orgId: string, id: string): Promise<PODTO> {
  const doc = await PurchaseOrder.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Purchase order not found");
  return toDTO(doc as unknown as PurchaseOrderDoc);
}

export async function createPO(orgId: string, input: CreatePOInput): Promise<PODTO> {
  const vendor = await Vendor.findOne({ _id: input.vendorId, organizationId: orgId });
  if (!vendor) throw new AppError("NOT_FOUND", "Vendor not found");

  const lines = input.lineItems.map((l) => ({ ...l, lineTotalMinor: lineTotal(l) }));
  const subtotalMinor = lines.reduce((s, l) => s + l.quantity * l.unitPriceMinor, 0);
  const taxTotalMinor = lines.reduce((s, l) => {
    const taxable = l.quantity * l.unitPriceMinor - Math.round(l.quantity * l.unitPriceMinor * l.discountPct / 100);
    return s + Math.round(taxable * l.taxPct / 100);
  }, 0);
  const totalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  const poNumber = await nextNumber(orgId, "purchase-order", "PO-");

  const doc = await PurchaseOrder.create({
    organizationId: new Types.ObjectId(orgId),
    poNumber,
    vendorId: new Types.ObjectId(input.vendorId),
    vendorName: vendor.name,
    issueDate: new Date(input.issueDate),
    expectedDate: input.expectedDate ? new Date(input.expectedDate) : undefined,
    currency: input.currency ?? (vendor.currency as string) ?? "AED",
    lineItems: lines,
    subtotalMinor,
    taxTotalMinor,
    totalMinor,
    notes: input.notes ?? "",
  });
  return toDTO(doc as unknown as PurchaseOrderDoc);
}

export async function updatePO(orgId: string, id: string, input: UpdatePOInput): Promise<PODTO> {
  const doc = await PurchaseOrder.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Purchase order not found");
  if (!["draft"].includes(doc.status as string)) throw new AppError("CONFLICT", "Only draft POs can be edited");

  if (input.issueDate) doc.issueDate = new Date(input.issueDate) as unknown as typeof doc.issueDate;
  if (input.expectedDate) doc.expectedDate = new Date(input.expectedDate) as unknown as typeof doc.expectedDate;
  if (input.notes !== undefined) doc.notes = input.notes;

  if (input.lineItems) {
    const lines = input.lineItems.map((l) => ({ ...l, lineTotalMinor: lineTotal(l) }));
    doc.lineItems = lines as unknown as typeof doc.lineItems;
    doc.subtotalMinor = lines.reduce((s, l) => s + l.quantity * l.unitPriceMinor, 0);
    doc.taxTotalMinor = lines.reduce((s, l) => {
      const taxable = l.quantity * l.unitPriceMinor - Math.round(l.quantity * l.unitPriceMinor * l.discountPct / 100);
      return s + Math.round(taxable * l.taxPct / 100);
    }, 0);
    doc.totalMinor = lines.reduce((s, l) => s + l.lineTotalMinor, 0);
  }

  await doc.save();
  return toDTO(doc as unknown as PurchaseOrderDoc);
}

export async function sendPO(orgId: string, id: string): Promise<PODTO> {
  const doc = await PurchaseOrder.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Purchase order not found");
  if (doc.status !== "draft") throw new AppError("CONFLICT", "Only draft POs can be sent");
  doc.status = "sent";
  await doc.save();
  return toDTO(doc as unknown as PurchaseOrderDoc);
}

export async function receivePO(orgId: string, id: string): Promise<PODTO> {
  const doc = await PurchaseOrder.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Purchase order not found");
  if (!["sent"].includes(doc.status as string)) throw new AppError("CONFLICT", "Only sent POs can be marked received");
  doc.status = "received";
  await doc.save();
  return toDTO(doc as unknown as PurchaseOrderDoc);
}

export async function convertPOToBill(orgId: string, id: string): Promise<{ billId: string; billNumber: string }> {
  const doc = await PurchaseOrder.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Purchase order not found");
  if (doc.status !== "received") throw new AppError("CONFLICT", "PO must be received before converting to a bill");

  const billNumber = await nextNumber(orgId, "bill", "BILL-");
  const today = new Date();
  const due = new Date(today);
  due.setDate(due.getDate() + 30);

  const bill = await Bill.create({
    organizationId: new Types.ObjectId(orgId),
    billNumber,
    vendorId: doc.vendorId,
    vendorName: doc.vendorName,
    sourcePOId: doc._id,
    sourcePONumber: doc.poNumber,
    billDate: today,
    dueDate: due,
    currency: doc.currency,
    lineItems: doc.lineItems,
    subtotalMinor: doc.subtotalMinor,
    taxTotalMinor: doc.taxTotalMinor,
    totalMinor: doc.totalMinor,
    balanceMinor: doc.totalMinor,
    notes: doc.notes,
    status: "draft",
    approvalStatus: "not_required",
  });

  doc.status = "billed";
  doc.set("sourceBillId", bill._id);
  await doc.save();

  return { billId: String(bill._id), billNumber: bill.billNumber };
}

export async function cancelPO(orgId: string, id: string): Promise<PODTO> {
  const doc = await PurchaseOrder.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Purchase order not found");
  if (["billed", "cancelled"].includes(doc.status as string))
    throw new AppError("CONFLICT", "This PO cannot be cancelled");
  doc.status = "cancelled";
  await doc.save();
  return toDTO(doc as unknown as PurchaseOrderDoc);
}
