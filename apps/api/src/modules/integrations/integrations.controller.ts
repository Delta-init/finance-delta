import type { Request, Response } from "express";
import { inboundEnrolmentSchema } from "@delta/shared";
import { asyncHandler, ok, AppError } from "../../lib/http";
import { Organization } from "../organization/organization.model";
import { Item } from "../inventory/item.model";
import { Invoice } from "../invoice/invoice.model";
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
 * total. A calling system needs enough to show somebody where their sale got
 * to; it has no business reading the rest of the ledger.
 */
export const enrolmentStatuses = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const source = String(req.body?.source ?? "").trim();
  const rawIds = Array.isArray(req.body?.externalIds) ? req.body.externalIds : [];

  if (!source) throw new AppError("VALIDATION_ERROR", "source is required");
  const externalIds = rawIds.map((v: unknown) => String(v).trim()).filter(Boolean).slice(0, 200);
  if (externalIds.length === 0) return ok(res, []);

  const invoices = await Invoice.find({
    organizationId: orgId,
    "external.source": source,
    "external.externalId": { $in: externalIds },
  })
    .select("invoiceNumber status approval totalMinor amountPaidMinor balanceMinor currency external issueDate")
    .lean();

  ok(
    res,
    invoices.map((i) => {
      const ext = i.external as { externalId?: string } | undefined;
      const approval = i.approval as { state?: string; returnedReason?: string } | undefined;
      return {
        externalId: ext?.externalId ?? "",
        invoiceId: String(i._id),
        invoiceNumber: (i.invoiceNumber as string) ?? "",
        status: (i.status as string) ?? "",
        // "not_required" for an invoice raised by somebody trusted with the
        // whole ledger, which is not the same as "nobody has looked yet".
        approval: approval?.state ?? "not_required",
        returnedReason: approval?.returnedReason ?? "",
        issueDate: i.issueDate ? new Date(i.issueDate as unknown as string).toISOString().slice(0, 10) : "",
        currency: (i.currency as string) ?? "",
        totalMinor: (i.totalMinor as number) ?? 0,
        amountPaidMinor: (i.amountPaidMinor as number) ?? 0,
        balanceMinor: (i.balanceMinor as number) ?? 0,
      };
    }),
  );
});
