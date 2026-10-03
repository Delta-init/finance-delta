import type { Request, Response } from "express";
import { inboundEnrolmentSchema, inboundFundingRequestSchema, inboundTetraDepositSchema } from "@delta/shared";
import { asyncHandler, ok, AppError } from "../../lib/http";
import { Organization } from "../organization/organization.model";
import { Item } from "../inventory/item.model";
import { intakeEnrolment } from "./enrolment-intake.service";
import { enrolmentStatusesFor } from "./enrolment-status.service";
import { fundingRequestStatuses as statusesOfFundingRequests, intakeFundingRequest } from "../budget/budget.service";
import { intakeTetraDeposit } from "../tetra-deposit/tetra-deposit.service";

/**
 * A signed machine call carries no session, so it carries no organization
 * either. The caller names one and it is checked here — a header that decided
 * which tenant's books to write into, unchecked, would be the whole point of
 * multi-tenancy undone.
 */
async function organizationOf(req: Request): Promise<string> {
  const orgId = String(req.headers["x-delta-org"] ?? "").trim();
  if (!orgId) throw new AppError("VALIDATION_ERROR", "x-delta-org is required");
  if (!/^[a-f0-9]{24}$/i.test(orgId)) throw new AppError("VALIDATION_ERROR", "x-delta-org is not an id");
  const org = await Organization.findById(orgId).select("_id");
  if (!org) throw new AppError("NOT_FOUND", "Unknown organization");
  return String(org._id);
}

/** Says the door is open and the signature was accepted. Nothing else. */
export const ping = asyncHandler(async (_req: Request, res: Response) => {
  ok(res, { ok: true, at: new Date().toISOString() });
});

export const takeEnrolment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const parsed = inboundEnrolmentSchema.parse(req.body);
  ok(res, await intakeEnrolment(orgId, parsed));
});

/**
 * The catalogue, for a caller that needs to map its own courses onto it.
 *
 * Name, sku and price only. A calling system needs enough to show somebody a
 * list and let them pick; it has no business reading stock levels or margins.
 */
export const listItems = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const items = await Item.find({ organizationId: orgId, isActive: { $ne: false } })
    .select("name sku unitPriceMinor type")
    .sort({ name: 1 })
    .lean();
  ok(
    res,
    items.map((i) => ({
      id: String(i._id),
      name: i.name as string,
      sku: (i.sku as string) ?? "",
      unitPriceMinor: (i.unitPriceMinor as number) ?? 0,
      type: (i.type as string) ?? "",
    })),
  );
});

/**
 * What became of the enrolments a caller handed over.
 *
 * The CRM knows it sent an enrolment and got an invoice number back; it has no
 * way to learn that somebody in accounts later approved it or sent it back. So
 * a counsellor asking "was my enrolment accepted" had to be given a finance
 * login and told to go and look, which is a poor answer to a fair question.
 *
 * Asked for by the caller's own ids, in one request rather than one per row —
 * a page of twenty enrolments should cost one call, not twenty.
 *
 * Deliberately narrow: the approval state, the status, the number and the
 * total — and, once approved, what became of the student in the LMS and in
 * Tetra Commission, with their CS and CS team there (enrolment-status.service).
 * A calling system needs enough to show somebody where their sale got to; it
 * has no business reading the rest of the ledger.
 */
export const enrolmentStatuses = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const source = String(req.body?.source ?? "").trim();
  const rawIds = Array.isArray(req.body?.externalIds) ? req.body.externalIds : [];

  if (!source) throw new AppError("VALIDATION_ERROR", "source is required");
  const externalIds = rawIds.map((v: unknown) => String(v).trim()).filter(Boolean).slice(0, 200);
  if (externalIds.length === 0) return ok(res, []);

  ok(res, await enrolmentStatusesFor(orgId, source, externalIds));
});

/**
 * A fund request from another system: money out of a department's allocation,
 * waiting for somebody in finance to approve it.
 */
export const takeFundingRequest = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const parsed = inboundFundingRequestSchema.parse(req.body);
  ok(res, await intakeFundingRequest(orgId, parsed));
});

/**
 * Where those requests got to. The decision, who made it and their note —
 * enough for the requester to be told, and nothing of the rest of the budget.
 */
export const fundingRequestStatuses = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const source = String(req.body?.source ?? "").trim();
  const rawIds = Array.isArray(req.body?.externalIds) ? req.body.externalIds : [];

  if (!source) throw new AppError("VALIDATION_ERROR", "source is required");
  const externalIds = rawIds.map((v: unknown) => String(v).trim()).filter(Boolean).slice(0, 200);
  if (externalIds.length === 0) return ok(res, []);

  ok(res, await statusesOfFundingRequests(orgId, source, externalIds));
});

/**
 * A deposit request from Tetra Commission, for an accountant to approve or
 * reject. The decision goes back to Tetra Commission on its own link; see
 * modules/tetra-deposit.
 */
export const takeTetraDeposit = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const parsed = inboundTetraDepositSchema.parse(req.body);
  ok(res, await intakeTetraDeposit(orgId, parsed));
});
