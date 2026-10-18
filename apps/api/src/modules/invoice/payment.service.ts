import { Types, type PipelineStage } from "mongoose";
import { Invoice } from "./invoice.model";

export interface PaymentDTO {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  method: string;
  amountMinor: number;
  paidOn: string;
  accountName: string;
  reference: string;
  notes: string;
  currency: string;
  createdAt: string;
}

export async function listPayments(
  orgId: string,
  params: {
    invoiceId?: string;
    method?: string;
    dateFrom?: string;
    dateTo?: string;
    q?: string;
    sort?: string;
    dir?: string;
    limit?: number;
    page?: number;
  },
): Promise<{ data: PaymentDTO[]; meta: { total: number; page: number; pageSize: number; totalPages: number } }> {
  const invoiceMatch: Record<string, unknown> = {
    organizationId: new Types.ObjectId(orgId),
    "payments.0": { $exists: true },
  };
  if (params.invoiceId) invoiceMatch._id = new Types.ObjectId(params.invoiceId);

  // Payment-level filters applied after $unwind
  const paymentMatch: Record<string, unknown> = {};
  if (params.method) paymentMatch["payments.method"] = params.method;
  if (params.dateFrom || params.dateTo) {
    // paidOn is a date (the day, at midnight UTC): compared as one — as text it matched nothing (2026-10-18), so the
    // page's From/To always came back empty.
    const day = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00.000Z`) : null;
    const range: Record<string, Date> = {};
    const from = params.dateFrom ? day(params.dateFrom) : null;
    const to = params.dateTo ? day(params.dateTo) : null;
    if (from) range.$gte = from;
    if (to) range.$lt = new Date(to.getTime() + 86_400_000);
    if (Object.keys(range).length) paymentMatch["payments.paidOn"] = range;
  }

  const hasPaymentFilter = Object.keys(paymentMatch).length > 0;

  // Search: match invoice number or customer name
  const searchMatch: Record<string, unknown> = {};
  if (params.q) {
    const re = new RegExp(params.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    searchMatch.$or = [{ invoiceNumber: re }, { customerName: re }];
  }

  const SORT_FIELDS: Record<string, string> = {
    paidOn: "payments.paidOn",
    amount: "payments.amountMinor",
    method: "payments.method",
    invoice: "invoiceNumber",
    customer: "customerName",
  };
  const sortField = SORT_FIELDS[params.sort ?? ""] ?? "payments.paidOn";
  const sortDir = params.dir === "asc" ? 1 : -1;

  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, params.limit ?? 25));
  const skip = (page - 1) * pageSize;

  const pipeline: PipelineStage[] = [
    { $match: invoiceMatch },
    { $unwind: "$payments" },
    ...(hasPaymentFilter ? [{ $match: paymentMatch }] : []),
    ...(params.q ? [{ $match: searchMatch }] : []),
    // Ending in the payment's id, so paging (and an export reading every page) never repeats or skips one.
    { $sort: { [sortField]: sortDir as 1 | -1, "payments.createdAt": -1, "payments._id": -1 } },
  ];

  const [rows, countResult] = await Promise.all([
    Invoice.aggregate([
      ...pipeline,
      { $skip: skip },
      { $limit: pageSize },
      {
        $project: {
          _id: 0,
          id: { $toString: "$payments._id" },
          invoiceId: { $toString: "$_id" },
          invoiceNumber: 1,
          customerId: { $toString: "$customerId" },
          customerName: 1,
          method: "$payments.method",
          amountMinor: "$payments.amountMinor",
          paidOn: "$payments.paidOn",
          accountName: { $ifNull: ["$payments.accountName", ""] },
          reference: { $ifNull: ["$payments.reference", ""] },
          notes: { $ifNull: ["$payments.notes", ""] },
          currency: 1,
          createdAt: { $toString: "$payments.createdAt" },
        },
      },
    ]),
    Invoice.aggregate([...pipeline, { $count: "total" }]),
  ]);

  const total = (countResult[0]?.total as number) ?? 0;

  return {
    data: rows as PaymentDTO[],
    meta: { total, page, pageSize, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function getPayment(orgId: string, paymentId: string): Promise<PaymentDTO | null> {
  const rows = await Invoice.aggregate([
    {
      $match: {
        organizationId: new Types.ObjectId(orgId),
        "payments._id": new Types.ObjectId(paymentId),
      },
    },
    { $unwind: "$payments" },
    { $match: { "payments._id": new Types.ObjectId(paymentId) } },
    {
      $project: {
        _id: 0,
        id: { $toString: "$payments._id" },
        invoiceId: { $toString: "$_id" },
        invoiceNumber: 1,
        customerId: { $toString: "$customerId" },
        customerName: 1,
        method: "$payments.method",
        amountMinor: "$payments.amountMinor",
        paidOn: "$payments.paidOn",
        accountName: { $ifNull: ["$payments.accountName", ""] },
        reference: { $ifNull: ["$payments.reference", ""] },
        notes: { $ifNull: ["$payments.notes", ""] },
        currency: 1,
        createdAt: { $toString: "$payments.createdAt" },
      },
    },
    { $limit: 1 },
  ]);
  return (rows[0] as PaymentDTO) ?? null;
}
