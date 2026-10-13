import { Types } from "mongoose";
import {
  formatMoney, type BalancePayment, type DecideBalancePaymentInput, type InboundBalancePayment,
} from "@delta/shared";
import type { AuthContext } from "../../middleware/auth";
import { env } from "../../config/env";
import { AppError } from "../../lib/http";
import { logger } from "../../lib/logger";
import { sendNotice } from "../../lib/email";
import { withAccountants } from "../../lib/approval-recipients";
import { Invoice } from "../invoice/invoice.model";
import { Role } from "../role/role.model";
import { User } from "../user/user.model";
import { BalancePaymentModel } from "./balance-payment.model";

/*
 * Balance payments from the sales CRMs (the user, 2026-10-13): the next payment
 * of a part-paid enrolment, recorded by the salesperson who closed it, with its
 * receipt. It waits on the Approvals page; approved, it is recorded on the
 * invoice through recordPayment — the next due date and every update follow, as
 * for accounts' own — with a receipt number; rejected, with why. The CRM reads
 * where each one stands with the enrolment's status (paymentsFor below).
 */

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : "");

/** Why this payment cannot go on the invoice as it stands, or null. */
function refusalFor(invoice: any, amountMinor: number, waitingMinor: number): string | null {
  if (!invoice) return "The enrolment it pays towards is not in finance";
  const n = invoice.invoiceNumber;
  if (invoice.status === "void") return `Invoice ${n} is void`;
  if (invoice.approval?.state !== "approved") return `Invoice ${n} is not approved yet`;
  const balance = Number(invoice.balanceMinor) || 0;
  if (balance <= 0) return `Invoice ${n} is already paid in full`;
  if (amountMinor + waitingMinor > balance) {
    return waitingMinor
      ? `${formatMoney(amountMinor, invoice.currency)} and the ${formatMoney(waitingMinor, invoice.currency)} already waiting come to more than the ${formatMoney(balance, invoice.currency)} left on invoice ${n}`
      : `${formatMoney(amountMinor, invoice.currency)} is more than the ${formatMoney(balance, invoice.currency)} left on invoice ${n}`;
  }
  return null;
}

const waitingOn = async (invoiceId: unknown, except?: unknown) =>
  (await BalancePaymentModel.find({ invoiceId, status: "pending", ...(except ? { _id: { $ne: except } } : {}) }).select("amountMinor").lean())
    .reduce((s, p) => s + (Number(p.amountMinor) || 0), 0);

export function balancePaymentDTO(r: any, invoice?: any): BalancePayment {
  return {
    id: String(r._id),
    status: r.status,
    source: r.source,
    invoiceId: String(r.invoiceId),
    invoiceNumber: r.invoiceNumber ?? "",
    customerName: r.customerName ?? "",
    course: r.course ?? "",
    amountMinor: r.amountMinor,
    currency: r.currency,
    method: r.method,
    paidOn: r.paidOn,
    receipt: { name: r.receipt?.name ?? "Receipt", url: r.receipt?.url ?? "", ...(r.receipt?.mimeType ? { mimeType: r.receipt.mimeType } : {}) },
    note: r.note ?? "",
    recordedBy: { name: r.recordedBy?.name ?? "", email: r.recordedBy?.email ?? "" },
    receivedAt: iso(r.createdAt),
    ...(invoice
      ? { invoice: { totalMinor: invoice.totalMinor ?? 0, paidMinor: invoice.amountPaidMinor ?? 0, balanceMinor: invoice.balanceMinor ?? 0, status: invoice.status ?? "" } }
      : {}),
    ...(r.decision?.decidedAt
      ? {
          decision: {
            decidedByName: r.decision.decidedByName ?? "",
            decidedAt: iso(r.decision.decidedAt),
            ...(r.decision.reason ? { reason: r.decision.reason } : {}),
            ...(r.decision.reference ? { reference: r.decision.reference } : {}),
            ...(r.decision.note ? { note: r.decision.note } : {}),
            ...(r.receiptNumber ? { receiptNumber: r.receiptNumber } : {}),
          },
        }
      : {}),
  };
}

/** Everyone here who approves enrolments, and the accountants: told one is waiting. Never throws. */
async function tellApprovers(orgId: string, p: BalancePayment): Promise<void> {
  try {
    const org = new Types.ObjectId(orgId);
    const roles = await Role.find({ organizationId: org, $or: [{ permissions: "invoice:write" }, { permissions: "*" }] }).select("_id");
    const people = roles.length
      ? await User.find({ status: "active", memberships: { $elemMatch: { organizationId: org, roleId: { $in: roles.map((r) => r._id) }, status: { $nin: ["suspended", "invited"] } } } }).select("email")
      : [];
    const to = await withAccountants(org, people.map((u) => u.email as string).filter(Boolean));
    if (!to.length) return;
    await sendNotice({
      log: { organizationId: orgId, kind: "balance_payment_notice", ref: { type: "invoice", id: p.invoiceId, label: p.invoiceNumber } },
      to,
      subject: `Balance payment to approve: ${p.customerName} — ${formatMoney(p.amountMinor, p.currency)}`,
      title: "A balance payment from a sales CRM is waiting for approval",
      lines: [
        `${p.recordedBy.name || "The salesperson"} recorded ${formatMoney(p.amountMinor, p.currency)} paid on ${p.paidOn} by ${p.method.replace(/_/g, " ")} towards invoice ${p.invoiceNumber}${p.course ? ` (${p.course})` : ""} for ${p.customerName}.`,
        "Approving it records the payment on the invoice, which sets the next due date. Check it against the receipt first.",
      ],
      actionLabel: "Review it",
      actionUrl: `${env.WEB_ORIGIN}/approvals`,
    });
  } catch (err) {
    logger.error({ err }, "Could not tell anyone a balance payment is waiting");
  }
}

/** A CRM's balance payment, received — or the one it already sent under that id. */
export async function intakeBalancePayment(orgId: string, input: InboundBalancePayment): Promise<BalancePayment> {
  await BalancePaymentModel.init();
  const org = new Types.ObjectId(orgId);
  const made = await BalancePaymentModel.findOne({ organizationId: org, source: input.source, externalId: input.externalId }).lean();
  if (made) return balancePaymentDTO(made);
  const invoice: any = await Invoice.findOne({ organizationId: org, "external.source": input.source, "external.externalId": input.enrolmentExternalId })
    .select("invoiceNumber customerName currency totalMinor amountPaidMinor balanceMinor status approval enrolment.course").lean();
  const refusal = refusalFor(invoice, input.amountMinor, invoice ? await waitingOn(invoice._id) : 0);
  if (refusal) throw new AppError(invoice ? "CONFLICT" : "NOT_FOUND", refusal);
  let row;
  try {
    row = await BalancePaymentModel.create({
      organizationId: org,
      source: input.source,
      externalId: input.externalId,
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber ?? "",
      customerName: invoice.customerName ?? "",
      course: invoice.enrolment?.course ?? "",
      amountMinor: input.amountMinor,
      currency: invoice.currency ?? "AED",
      method: input.method,
      paidOn: input.paidOn,
      receipt: { name: input.receipt.name || "Receipt", url: input.receipt.url, key: input.receipt.key, ...(input.receipt.mimeType ? { mimeType: input.receipt.mimeType } : {}) },
      note: input.note ?? "",
      recordedBy: { name: input.recordedBy.name ?? "", email: input.recordedBy.email ?? "" },
    });
  } catch (err) {
    // The same payment twice at once: one made it in; answer with that one.
    if ((err as { code?: number }).code !== 11000) throw err;
    const raced = await BalancePaymentModel.findOne({ organizationId: org, source: input.source, externalId: input.externalId }).lean();
    if (!raced) throw err;
    return balancePaymentDTO(raced);
  }
  const dto = balancePaymentDTO(row.toObject());
  logger.info({ id: dto.id, invoice: dto.invoiceNumber }, "Balance payment received from a sales CRM");
  void tellApprovers(orgId, dto);
  return dto;
}

export async function getBalancePayment(orgId: string, id: string): Promise<BalancePayment> {
  if (!Types.ObjectId.isValid(id)) throw new AppError("NOT_FOUND", "Balance payment not found");
  const row = await BalancePaymentModel.findOne({ _id: id, organizationId: new Types.ObjectId(orgId) }).lean();
  if (!row) throw new AppError("NOT_FOUND", "Balance payment not found");
  const invoice = await Invoice.findById(row.invoiceId).select("totalMinor amountPaidMinor balanceMinor status").lean();
  return balancePaymentDTO(row, invoice);
}

/** The next receipt number, on the payment recorded for this request. */
async function issueReceipt(orgId: string, invoiceId: unknown, externalRef: string): Promise<{ paymentId: string; receiptNumber: string }> {
  const { nextNumber } = await import("../sequence/sequence.service");
  const doc: any = await Invoice.findById(invoiceId).select("payments._id payments.externalRef payments.receiptNumber").lean();
  const p = (doc?.payments ?? []).find((x: any) => x.externalRef === externalRef);
  if (!p) throw new AppError("CONFLICT", "The payment was not recorded on the invoice");
  if (p.receiptNumber) return { paymentId: String(p._id), receiptNumber: p.receiptNumber };
  const receiptNumber = await nextNumber(orgId, "receipt", "RCT-");
  await Invoice.updateOne({ _id: doc._id, payments: { $elemMatch: { _id: p._id, receiptNumber: { $exists: false } } } }, { $set: { "payments.$.receiptNumber": receiptNumber } });
  return { paymentId: String(p._id), receiptNumber };
}

/**
 * Approved: recorded on the invoice first (on the day it was paid, with its
 * receipt as the proof), then marked so. Rejected: with why. One decision each,
 * whoever gets there first; a payment that no longer fits is refused, still
 * waiting, for them to reject.
 */
export async function decideBalancePayment(auth: AuthContext, id: string, input: DecideBalancePaymentInput): Promise<BalancePayment> {
  if (!Types.ObjectId.isValid(id)) throw new AppError("NOT_FOUND", "Balance payment not found");
  const org = new Types.ObjectId(auth.organizationId);
  const row: any = await BalancePaymentModel.findOne({ _id: id, organizationId: org }).lean();
  if (!row) throw new AppError("NOT_FOUND", "Balance payment not found");
  if (row.status !== "pending") throw new AppError("CONFLICT", `This balance payment is already ${row.status}`);
  const me = await User.findById(auth.userId).select("name").lean();
  const decided = { decidedById: new Types.ObjectId(auth.userId), decidedByName: String(me?.name ?? "Accounts"), decidedAt: new Date() };

  if (input.decision === "rejected") {
    const res = await BalancePaymentModel.updateOne({ _id: row._id, status: "pending" }, { $set: { status: "rejected", decision: { ...decided, reason: input.reason } } });
    if (!res.modifiedCount) throw new AppError("CONFLICT", "Somebody decided it just now");
    return getBalancePayment(auth.organizationId, id);
  }

  const invoice: any = await Invoice.findById(row.invoiceId).select("invoiceNumber currency balanceMinor status approval").lean();
  const externalRef = `crm-balance:${row._id}`;
  const already = (await Invoice.exists({ _id: row.invoiceId, "payments.externalRef": externalRef })) !== null;
  if (!already) {
    const refusal = refusalFor(invoice, row.amountMinor, await waitingOn(row.invoiceId, row._id));
    if (refusal) throw new AppError("CONFLICT", `Not recorded: ${refusal}`);
    // Claimed before it is recorded, so two accountants never record it twice.
    const claim = await BalancePaymentModel.updateOne({ _id: row._id, status: "pending", "decision.decidedAt": { $exists: false } }, { $set: { decision: decided } });
    if (!claim.modifiedCount) throw new AppError("CONFLICT", "Somebody is deciding it just now");
    try {
      const { recordPayment } = await import("../invoice/invoice.service");
      await recordPayment(auth.organizationId, String(row.invoiceId), {
        method: row.method,
        amountMinor: row.amountMinor,
        paidOn: row.paidOn,
        reference: input.reference ?? "",
        notes: [`Recorded in the sales CRM${row.recordedBy?.name ? ` by ${row.recordedBy.name}` : ""}`, `approved by ${decided.decidedByName}`, input.note].filter(Boolean).join(" · ").slice(0, 1000),
        accountName: "",
        chargesMinor: 0,
      } as never, undefined, { externalRef, proofUrl: row.receipt?.url ?? "" });
    } catch (err) {
      await BalancePaymentModel.updateOne({ _id: row._id, status: "pending" }, { $unset: { decision: "" } });
      if (err instanceof AppError) throw new AppError("CONFLICT", `Not recorded: ${err.message}`);
      throw err;
    }
  }
  const receipt = await issueReceipt(auth.organizationId, row.invoiceId, externalRef);
  await BalancePaymentModel.updateOne({ _id: row._id }, {
    $set: {
      status: "approved", paymentId: receipt.paymentId, receiptNumber: receipt.receiptNumber,
      decision: { ...decided, ...(input.reference ? { reference: input.reference } : {}), ...(input.note ? { note: input.note } : {}) },
    },
  });
  logger.info({ id, invoice: invoice?.invoiceNumber }, "Balance payment approved and recorded");
  return getBalancePayment(auth.organizationId, id);
}

/** For the CRM, with each enrolment's status: every balance payment it recorded on these invoices, oldest first. */
export async function balancePaymentsFor(invoiceIds: unknown[]): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>();
  if (!invoiceIds.length) return out;
  const rows = await BalancePaymentModel.find({ invoiceId: { $in: invoiceIds } }).sort({ createdAt: 1 }).lean();
  for (const r of rows as any[]) {
    const k = String(r.invoiceId);
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push({
      externalId: r.externalId,
      amountMinor: r.amountMinor,
      currency: r.currency,
      method: r.method,
      paidOn: r.paidOn,
      status: r.status,
      ...(r.decision?.reason ? { reason: r.decision.reason } : {}),
      ...(r.decision?.decidedAt && r.status !== "pending" ? { decidedAt: iso(r.decision.decidedAt), decidedBy: r.decision.decidedByName ?? "" } : {}),
      ...(r.receiptNumber ? { receiptNumber: r.receiptNumber } : {}),
    });
  }
  return out;
}
