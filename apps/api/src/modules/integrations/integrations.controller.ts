import type { Request, Response } from "express";
import { inboundEnrolmentSchema, inboundFundingRequestSchema, inboundTetraDepositSchema, inboundTetraDepositRecheckSchema, inboundBalancePaymentSchema, inboundCourseChangeSchema, inboundSalesNoteSchema } from "@delta/shared";
import { asyncHandler, ok, AppError } from "../../lib/http";
import { CRM_COMMISSION_MONTH } from "@delta/shared";
import { payoutsForCrm } from "../crm-commission/crm-commission.service";
import { Organization } from "../organization/organization.model";
import { Item } from "../inventory/item.model";
import { intakeEnrolment, updateSalesNote } from "./enrolment-intake.service";
import { enrolmentStatusesFor } from "./enrolment-status.service";
import { oldBooksPaymentsSince } from "./old-books-payments.service";
import { fundingRequestStatuses as statusesOfFundingRequests, intakeFundingRequest } from "../budget/budget.service";
import { intakeTetraDeposit, recheckTetraDeposit, withdrawTetraDeposit } from "../tetra-deposit/tetra-deposit.service";
import { walletForHrms } from "./hrms-wallet.service";
import { dgoCollectionsForHrms } from "./hrms-dgo-collections.service";

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
 * CS Portal, with their CS and CS team there (enrolment-status.service).
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

/** A sales CRM's balance payment (2026-10-13): waits for accounts; the enrolment's status says where it stands. */
/**
 * The sales note of an enrolment already sent, as it is now in the CRM. Only
 * the note changes; 404 for an enrolment this organization does not have, so
 * the CRM keeps it and tries again (it may simply not have been sent yet).
 */
export const updateEnrolmentSalesNote = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const input = inboundSalesNoteSchema.parse(req.body);
  const updated = await updateSalesNote(orgId, input);
  if (!updated) throw new AppError("NOT_FOUND", "No enrolment with that id here");
  ok(res, updated);
});

export const takeBalancePayment = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const input = inboundBalancePaymentSchema.parse(req.body);
  const { intakeBalancePayment } = await import("../balance-payment/balance-payment.service");
  ok(res, await intakeBalancePayment(orgId, input));
});

/** A sales CRM's course change (2026-11-23): waits for accounts; the enrolment's status says where it stands. */
export const takeCourseChange = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const input = inboundCourseChangeSchema.parse(req.body);
  const { intakeCourseChange } = await import("../course-change/course-change.service");
  ok(res, await intakeCourseChange(orgId, input));
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
 * A deposit request from CS Portal, for an accountant to approve or
 * reject. The decision goes back to CS Portal on its own link; see
 * modules/tetra-deposit.
 */
export const takeTetraDeposit = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const parsed = inboundTetraDepositSchema.parse(req.body);
  ok(res, await intakeTetraDeposit(orgId, parsed));
});

/**
 * POST /integrations/tetra-deposits/recheck { …the intake's body, recheck: { key, from, byName, fields, note } } — a
 * bonus approved here, sent back to recheck by CS Portal's broker admin, or corrected by the CS after the broker admin
 * sent it to them (2026-11-19): back to pending, its payment off the invoice. 404 when finance never had it; 409 with a
 * plain reason when it can't be (not a bonus, not approved, being decided again, a reconciled payment). Safe to repeat
 * with the same key.
 */
export const recheckTetraDepositHandler = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const parsed = inboundTetraDepositRecheckSchema.parse(req.body);
  ok(res, await recheckTetraDeposit(orgId, parsed));
});

/**
 * POST /integrations/tetra-deposits/withdrawals { externalId, byName?, reason? } — CS Portal rejected (or deleted) a
 * payment approved here (2026-10-31): its invoice payment comes off. Always answered with an outcome, never a 404 for
 * an unknown id — CS Portal reads a 404 as "finance isn't updated yet" and tries again.
 */
export const withdrawTetraDepositHandler = asyncHandler(async (req: Request, res: Response) => {
  const orgId = await organizationOf(req);
  const externalId = String(req.body?.externalId ?? "").trim();
  if (!/^[a-f0-9]{24}$/i.test(externalId)) throw new AppError("VALIDATION_ERROR", "externalId is CS Portal's request id");
  const byName = String(req.body?.byName ?? "").trim().slice(0, 120);
  const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
  // deleted: CS Portal deleted a pending or rejected request, and finance's copy comes off with it (2026-11-12).
  ok(res, await withdrawTetraDeposit(orgId, { externalId, byName, reason, deleted: req.body?.deleted === true }));
});

/**
 * GET /integrations/crm-commission/payouts?crm=&month= — a sales CRM asking where finance stands on its people's
 * commission for a month, for its My Pay (2026-10-21): approved (by whom, when, the amount frozen then) or paid
 * (when, how, the reference). Read-only; nothing about a month nobody approved.
 */
export const crmCommissionPayouts = asyncHandler(async (req: Request, res: Response) => {
  const crm = String(req.query.crm ?? "").trim();
  const month = String(req.query.month ?? "");
  if (!/^[a-z0-9-]{1,40}$/.test(crm)) throw new AppError("VALIDATION_ERROR", "crm is required");
  if (!CRM_COMMISSION_MONTH.test(month)) throw new AppError("VALIDATION_ERROR", "month is YYYY-MM");
  ok(res, await payoutsForCrm(crm, month));
});

/**
 * GET /integrations/old-books/payments?from=YYYY-MM-DD — the old books' invoices with money paid on or after `from`,
 * each with its salesperson's email, fee and payments (2026-11-25): counted for the salesperson in the sales CRMs and
 * Root. Read-only.
 */
export const oldBooksPayments = asyncHandler(async (req: Request, res: Response) => {
  const from = String(req.query.from ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from))) throw new AppError("VALIDATION_ERROR", "from is YYYY-MM-DD");
  ok(res, await oldBooksPaymentsSince(from));
});

/**
 * POST /integrations/hrms/wallet { employeeId, emails, month } — HRMS's wallet page (2026-11-04) asking what finance
 * knows about one person's month: payroll owed and paid (part payments included), and their CRM and CS commission,
 * found by the emails HRMS has for them. Read-only. POST so the emails travel in the signed body, not the address.
 */
export const hrmsWallet = asyncHandler(async (req: Request, res: Response) => {
  const employeeId = String(req.body?.employeeId ?? "").trim();
  const month = String(req.body?.month ?? "");
  if (!/^[a-f0-9]{24}$/i.test(employeeId)) throw new AppError("VALIDATION_ERROR", "employeeId is the HRMS employee id");
  if (!/^\d{4}-\d{2}$/.test(month)) throw new AppError("VALIDATION_ERROR", "month is YYYY-MM");
  const emails = [...new Set((Array.isArray(req.body?.emails) ? req.body.emails : [])
    .map((e: unknown) => String(e ?? "").trim().toLowerCase())
    .filter((e: string) => /^\S+@\S+\.\S+$/.test(e)))].slice(0, 5) as string[];
  ok(res, await walletForHrms({ employeeId, emails, month }));
});

/**
 * POST /integrations/hrms/dgo-collections { hrmsOrgId, month } — HRMS's DGO Points budget (2026-11-21) asking for a
 * month's eligible collections: payments received in the Dubai month, net of VAT, in the base currency, with the
 * reconciled share, back-dated payments still waiting, and credit notes for information. Read-only. POST, like the
 * wallet above, so HRMS signs it with the client it already has.
 */
export const hrmsDgoCollections = asyncHandler(async (req: Request, res: Response) => {
  const hrmsOrgId = String(req.body?.hrmsOrgId ?? "").trim();
  const month = String(req.body?.month ?? "");
  if (!/^[\w-]{1,64}$/.test(hrmsOrgId)) throw new AppError("VALIDATION_ERROR", "hrmsOrgId is the HRMS organisation id");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new AppError("VALIDATION_ERROR", "month is YYYY-MM");
  ok(res, await dgoCollectionsForHrms({ hrmsOrgId, month }));
});
