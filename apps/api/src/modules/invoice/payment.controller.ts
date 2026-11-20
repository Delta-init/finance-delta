import type { Request } from "express";
import { asyncHandler, ok, AppError } from "../../lib/http";
import { getPayment, listPayments, paymentSummary, type PaymentFilters } from "./payment.service";

const orgId = (req: Request) => req.auth!.organizationId;

/** The list's filters, read the same way for the table and its cards. */
const filtersOf = (req: Request): PaymentFilters => ({
  invoiceId: req.query.invoiceId as string | undefined,
  method: req.query.method as string | undefined,
  dateFrom: req.query.dateFrom as string | undefined,
  dateTo: req.query.dateTo as string | undefined,
  q: req.query.q as string | undefined,
});

export const list = asyncHandler(async (req, res) => {
  const result = await listPayments(orgId(req), {
    ...filtersOf(req),
    sort: req.query.sort as string | undefined,
    dir: req.query.dir as string | undefined,
    page: req.query.page ? Number(req.query.page) : undefined,
    limit: req.query.pageSize ? Number(req.query.pageSize) : undefined,
  });
  ok(res, result);
});

/** The cards above the list (2026-11-20): what the same filters match. */
export const summary = asyncHandler(async (req, res) => {
  ok(res, await paymentSummary(orgId(req), filtersOf(req)));
});

export const get = asyncHandler(async (req, res) => {
  const payment = await getPayment(orgId(req), req.params.id!);
  if (!payment) throw new AppError("NOT_FOUND", "Payment not found");
  ok(res, payment);
});
