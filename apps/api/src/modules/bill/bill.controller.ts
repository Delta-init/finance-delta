import type { Request, Response } from "express";
import { billQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok, AppError } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as svc from "./bill.service";

const org = (req: Request) => req.auth!.organizationId;

export const list = asyncHandler(async (req, res) => {
  const query = parseQuery(billQuerySchema, req.query);
  const result = await svc.listBills(org(req), query);
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req, res) => {
  ok(res, await svc.getBill(org(req), req.params.id!));
});

export const create = asyncHandler(async (req, res) => {
  created(res, await svc.createBill(org(req), req.body));
});

export const update = asyncHandler(async (req, res) => {
  ok(res, await svc.updateBill(org(req), req.params.id!, req.body));
});

export const approve = asyncHandler(async (req, res) => {
  ok(res, await svc.approveBill(org(req), req.params.id!));
});

export const reject = asyncHandler(async (req, res) => {
  ok(res, await svc.rejectBill(org(req), req.params.id!));
});

export const recordPayment = asyncHandler(async (req, res) => {
  ok(res, await svc.recordBillPayment(org(req), req.params.id!, req.body));
});

export const updatePayment = asyncHandler(async (req, res) => {
  ok(res, await svc.updateBillPayment(org(req), req.params.id!, req.params.paymentId!, req.body));
});

export const voidBill = asyncHandler(async (req, res) => {
  ok(res, await svc.voidBill(org(req), req.params.id!));
});

export const remove = asyncHandler(async (req, res) => {
  await svc.deleteBill(org(req), req.params.id!);
  res.status(204).end();
});

export const updateNotes = asyncHandler(async (req, res) => {
  ok(res, await svc.updateBillNotes(org(req), req.params.id!, (req.body?.notes as string) ?? ""));
});

export const addAttachment = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("VALIDATION_ERROR", "No file uploaded");
  const name = typeof req.body?.name === "string" ? req.body.name : undefined;
  created(res, await svc.addBillAttachment(org(req), req.params.id!, req.file, name));
});

export const removeAttachment = asyncHandler(async (req, res) => {
  ok(res, await svc.removeBillAttachment(org(req), req.params.id!, req.params.attId!));
});
