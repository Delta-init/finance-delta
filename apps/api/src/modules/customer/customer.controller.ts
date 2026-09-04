import type { Request, Response } from "express";
import { customerQuerySchema } from "@delta/shared";
import { asyncHandler, created, ok } from "../../lib/http";
import { parseQuery } from "../../middleware/validate";
import * as customerService from "./customer.service";

export const list = asyncHandler(async (req: Request, res: Response) => {
  const query = parseQuery(customerQuerySchema, req.query);
  const result = await customerService.listCustomers(req.auth!.organizationId, query);
  ok(res, result.data, result.meta);
});

export const get = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await customerService.getCustomer(req.auth!.organizationId, req.params.id!));
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  created(res, await customerService.createCustomer(req.auth!.organizationId, req.body));
});

/**
 * The client for an enrolment, found or made.
 *
 * Answers with `existed` so the caller can say "this client was already here"
 * rather than leaving somebody to wonder whether a second record was created.
 */
export const findOrCreate = asyncHandler(async (req: Request, res: Response) => {
  const result = await customerService.findOrCreateCustomer(req.auth!.organizationId, req.body);
  ok(res, result);
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  ok(
    res,
    await customerService.updateCustomer(
      req.auth!.organizationId,
      req.params.id!,
      req.body,
    ),
  );
});

export const remove = asyncHandler(async (req: Request, res: Response) => {
  await customerService.deleteCustomer(req.auth!.organizationId, req.params.id!);
  res.status(204).end();
});

export const statement = asyncHandler(async (req: Request, res: Response) => {
  ok(res, await customerService.getCustomerStatement(req.auth!.organizationId, req.params.id!));
});
