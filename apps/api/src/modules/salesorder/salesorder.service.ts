import { Types } from "mongoose";
import {
  computeLine,
  sumTotals,
  type Paginated,
  type SalesOrder as SalesOrderDTO,
  type SalesOrderQuery,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { toTagRefs } from "../../lib/tags";
import { nextNumber } from "../sequence/sequence.service";
import { SalesOrder, type SalesOrderDoc } from "./salesorder.model";
import type { QuotationDoc } from "../quotation/quotation.model";

interface RawLine {
  description: string;
  quantity: number;
  unitPriceMinor: number;
  discountPct?: number;
  taxPct?: number;
}

export function buildLines(raw: RawLine[]) {
  const lineItems = raw.map((l) => {
    const b = computeLine(l);
    return {
      description: l.description,
      quantity: l.quantity,
      unitPriceMinor: l.unitPriceMinor,
      discountPct: l.discountPct ?? 0,
      taxPct: l.taxPct ?? 0,
      ...b,
    };
  });
  const totals = sumTotals(raw);
  return { lineItems, totals };
}

export function toDTO(doc: SalesOrderDoc): SalesOrderDTO {
  return {
    id: doc._id.toString(),
    orderNumber: doc.orderNumber,
    customerId: doc.customerId.toString(),
    customerName: doc.customerName,
    sourceQuoteId: doc.sourceQuoteId?.toString(),
    sourceQuoteNumber: doc.sourceQuoteNumber ?? undefined,
    status: doc.status as "open" | "fulfilled" | "cancelled",
    currency: doc.currency ?? "AED",
    lineItems: doc.lineItems as SalesOrderDTO["lineItems"],
    subtotalMinor: doc.subtotalMinor ?? 0,
    discountTotalMinor: doc.discountTotalMinor ?? 0,
    taxTotalMinor: doc.taxTotalMinor ?? 0,
    totalMinor: doc.totalMinor ?? 0,
    tags: toTagRefs(doc.tagIds),
    createdAt: doc.createdAt.toISOString(),
  };
}

const SORT = {
  number: "orderNumber",
  customer: "customerName",
  source: "sourceQuoteNumber",
  status: "status",
  total: "totalMinor",
  createdAt: "createdAt",
} as const;

export async function listSalesOrders(
  orgId: string,
  query: SalesOrderQuery,
): Promise<Paginated<SalesOrderDTO>> {
  const filter: Record<string, unknown> = { organizationId: orgId };
  const or = searchOr(query.q, ["orderNumber", "customerName", "sourceQuoteNumber"]);
  if (or) filter.$or = or;
  if (query.status) filter.status = query.status;
  if (query.tagIds?.length) filter.tagIds = { $in: query.tagIds };

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    SalesOrder.find(filter)
      .populate("tagIds", "name color")
      .sort(sort)
      .skip(skipFor(query.page, query.pageSize))
      .limit(query.pageSize),
    SalesOrder.countDocuments(filter),
  ]);
  return {
    data: rows.map((r) => toDTO(r as unknown as SalesOrderDoc)),
    meta: pageMeta(total, query.page, query.pageSize),
  };
}

export async function getSalesOrder(orgId: string, id: string): Promise<SalesOrderDTO> {
  const doc = await SalesOrder.findOne({ _id: id, organizationId: orgId }).populate(
    "tagIds",
    "name color",
  );
  if (!doc) throw new AppError("NOT_FOUND", "Sales order not found");
  return toDTO(doc as unknown as SalesOrderDoc);
}

/** Create a sales order from a quotation doc, optionally overriding line quantities. */
export async function createFromQuote(
  orgId: string,
  quote: QuotationDoc,
  overrides?: { index: number; quantity: number }[],
): Promise<SalesOrderDoc> {
  const qtyByIndex = new Map((overrides ?? []).map((o) => [o.index, o.quantity]));
  const raw: RawLine[] = quote.lineItems.map((l, i) => ({
    description: l.description,
    quantity: qtyByIndex.get(i) ?? l.quantity,
    unitPriceMinor: l.unitPriceMinor,
    discountPct: l.discountPct,
    taxPct: l.taxPct,
  }));

  const { lineItems, totals } = buildLines(raw);
  const orderNumber = await nextNumber(orgId, "salesorder", "SO-");

  return SalesOrder.create({
    organizationId: new Types.ObjectId(orgId),
    orderNumber,
    customerId: quote.customerId,
    customerName: quote.customerName,
    sourceQuoteId: quote._id,
    sourceQuoteNumber: quote.quoteNumber,
    status: "open",
    currency: quote.currency,
    lineItems,
    ...totals,
    tagIds: quote.tagIds ?? [],
  });
}

export async function cancelSalesOrder(orgId: string, id: string): Promise<SalesOrderDTO> {
  const doc = await SalesOrder.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Sales order not found");
  doc.status = "cancelled";
  await doc.save();
  return toDTO(doc);
}
