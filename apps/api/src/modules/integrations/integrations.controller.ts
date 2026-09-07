import type { Request, Response } from "express";
import { inboundEnrolmentSchema } from "@delta/shared";
import { asyncHandler, ok, AppError } from "../../lib/http";
import { Organization } from "../organization/organization.model";
import { Item } from "../inventory/item.model";
import { intakeEnrolment } from "./enrolment-intake.service";

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
