import type { Request, Response } from "express";
import { invoiceQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok, AppError } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import { resolveScope } from "../../lib/ownership";
import * as invoiceService from "./invoice.service";
import { autoCalculate } from "../commission/commission.service";

const orgId = (req: Request) => req.auth!.organizationId;

/**
 * Whose invoices this caller may touch. `invoice:write` is org-wide and also
 * covers deleting, voiding and recording payments; `invoice:write:own` covers
 * raising and sending your own and nothing else.
 */
const readScope = (req: Request) => resolveScope(req.auth!, "invoice:read", "invoice:read:own");
const writeScope = (req: Request) => resolveScope(req.auth!, "invoice:write", "invoice:write:own");

export const list = asyncHandler(async (req, res) => {
  const query = parseQuery(invoiceQuerySchema, req.query);
  const result = await invoiceService.listInvoices(orgId(req), query, readScope(req));
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await invoiceService.getInvoice(orgId(req), req.params.id!, readScope(req)));
});

export const create = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.createInvoice(orgId(req), req.body, writeScope(req));
  void autoCalculate(orgId(req), invoice.id, "invoice_raised").catch(() => undefined);
  created(res, invoice);
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await invoiceService.updateInvoice(orgId(req), req.params.id!, req.body, writeScope(req)));
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await invoiceService.deleteInvoice(orgId(req), req.params.id!);
  res.status(204).end();
});

export const restore = asyncHandler(async (req, res) => {
  ok(res, await invoiceService.restoreInvoice(orgId(req), req.params.id!));
});

export const send = asyncHandler(async (req, res) => {
  ok(res, await invoiceService.sendInvoice(orgId(req), req.params.id!, writeScope(req)));
});

export const voidInvoice = asyncHandler(async (req, res) => {
  ok(res, await invoiceService.voidInvoice(orgId(req), req.params.id!));
});

export const recordPayment = asyncHandler(async (req, res) => {
  const payment = await invoiceService.recordPayment(orgId(req), req.params.id!, req.body, req.file);
  void autoCalculate(orgId(req), req.params.id!, "payment_received").catch(() => undefined);
  created(res, payment);
});

export const updatePayment = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.updatePayment(orgId(req), req.params.id!, req.params.paymentId!, req.body);
  void autoCalculate(orgId(req), req.params.id!, "payment_received").catch(() => undefined);
  ok(res, invoice);
});

export const deletePayment = asyncHandler(async (req, res) => {
  const invoice = await invoiceService.deletePayment(orgId(req), req.params.id!, req.params.paymentId!);
  // Commission and anything else keyed off what has been received has to be
  // told, the same way it is told when a payment arrives or changes.
  void autoCalculate(orgId(req), req.params.id!, "payment_received").catch(() => undefined);
  ok(res, invoice);
});

export const resend = asyncHandler(async (req, res) => {
  await invoiceService.resendInvoice(orgId(req), req.params.id!, writeScope(req), req.body?.message);
  ok(res, { queued: true });
});

/** Who is acting, for the record an approval leaves behind. */
async function actorOf(req: Request) {
  const { User } = await import("../user/user.model");
  const u = await User.findOne({
    _id: req.auth!.userId,
    "memberships.organizationId": orgId(req),
  }).select("name");
  return { userId: req.auth!.userId, name: u?.name ?? "Unknown" };
}

export const addAttachment = asyncHandler(async (req: Request, res: Response) => {
  if (!req.file) throw new AppError("VALIDATION_ERROR", "No file was uploaded");
  ok(res, await invoiceService.addAttachment(orgId(req), req.params.id!, req.file, writeScope(req)));
});

export const removeAttachment = asyncHandler(async (req: Request, res: Response) => {
  // The key arrives as a path segment, so it is encoded on the way in.
  ok(res, await invoiceService.removeAttachment(
    orgId(req),
    req.params.id!,
    decodeURIComponent(req.params.key!),
    writeScope(req),
  ));
});

export const summary = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await invoiceService.invoiceSummary(orgId(req), readScope(req)));
});

export const approveInvoice = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await invoiceService.approveInvoice(orgId(req), req.params.id!, await actorOf(req)));
});

export const returnInvoice = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await invoiceService.returnInvoice(
    orgId(req), req.params.id!, req.body.reason, await actorOf(req),
  ));
});

export const resubmitInvoice = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await invoiceService.resubmitInvoice(orgId(req), req.params.id!, writeScope(req)));
});
