import { Types } from "mongoose";
import { paymentMethodLabel } from "@delta/shared";
import { declaredSide } from "./declared-side";
import { logger } from "../../lib/logger";
import {
  commissionConfigured, sendFeeUpdateToCommission, CommissionRefusedError, type CommissionFeeUpdate,
} from "../../lib/commission-client";
import { Invoice } from "../invoice/invoice.model";
import { Customer } from "../customer/customer.model";
import { isoDay } from "../invoice/instalments";
import { LmsProvision } from "./lms-provision.model";
import { CommissionFeeUpdateModel } from "./commission-fee-update.model";

/**
 * Tells CS Portal when an enrolment's money changes (the user,
 * 2026-10-11): after approval, a payment recorded, edited or deleted, the
 * invoice voided, restored or deleted, a credit note applied, or its due date
 * changed — for invoices whose student went there (the commission state the
 * LMS provisioning keeps: `sent`).
 *
 * Queued, never sent in the request that made the change: that change is
 * accounts' act and must not wait on, or fail because of, another system.
 * The worker (jobs/commission-fee-update.worker.ts) delivers it and keeps
 * trying until it arrives; 404 UNKNOWN_INVOICE (no such student or fee there)
 * stops it.
 */

type InvoiceLike = {
  _id: unknown;
  organizationId?: unknown;
  invoiceNumber?: string;
  customerId?: unknown;
  status?: string | null;
  currency?: string | null;
  totalMinor?: number | null;
  amountPaidMinor?: number | null;
  balanceMinor?: number | null;
  dueDate?: Date | null;
  enrolment?: {
    course?: string | null;
    declaredPaidMinor?: number | null;
    declaredPaymentMethod?: string | null;
    declaredPayments?: ReadonlyArray<{ method?: string | null; amountMinor?: number | null; paidOn?: string | null; receipt?: { url?: string | null; name?: string | null } | null }> | null;
  } | null;
  attachments?: ReadonlyArray<{ name?: string | null; url?: string | null; key?: string | null }> | null;
  payments?: ReadonlyArray<{ amountMinor?: number | null; paidOn?: Date | string | null; method?: string | null; proofUrl?: string | null; receiptNumber?: string | null }> | null;
};


type ProvisionLike = {
  commission?: { state?: string | null; course?: string | null } | null;
  lmsCourseTitle?: string | null;
  payload?: unknown;
};

/** The whole picture of an invoice's money, as CS Portal is told it. */
export function buildFeeUpdate(
  invoice: InvoiceLike,
  provision: ProvisionLike | null,
  customerEmail: string,
  opts: { deleted?: boolean; at?: Date } = {},
): CommissionFeeUpdate {
  const total = invoice.totalMinor ?? 0;
  const paid = invoice.amountPaidMinor ?? 0;
  const balance = Math.max(0, invoice.balanceMinor ?? total - paid);
  const status: CommissionFeeUpdate["status"] = opts.deleted
    ? "deleted"
    : invoice.status === "void"
      ? "void"
      : balance <= 0
        ? "paid"
        : "partial";
  const sentEmail = (provision?.payload as { email?: string } | undefined)?.email;
  return {
    invoiceId: String(invoice._id),
    invoiceNumber: invoice.invoiceNumber ?? "",
    email: (sentEmail || customerEmail || "").trim().toLowerCase(),
    course: provision?.commission?.course || provision?.lmsCourseTitle || invoice.enrolment?.course || "",
    currency: invoice.currency ?? "AED",
    totalMinor: total,
    paidMinor: paid,
    balanceMinor: status === "paid" ? 0 : balance,
    status,
    nextDueOn: status === "partial" && invoice.dueDate ? isoDay(new Date(invoice.dueDate)) : null,
    payments: (invoice.payments ?? [])
      .filter((p) => p && p.paidOn)
      .map((p) => {
        const method = paymentMethodLabel(p.method ?? "") || String(p.method ?? "");
        return {
          amountMinor: p.amountMinor ?? 0,
          paidOn: isoDay(new Date(p.paidOn as Date)),
          method,
          // Each recorded payment's own receipt (the user, 2026-10-27: a second payment's receipt never reached
          // CS Portal — only the close's showed). Only a link a browser can open.
          receipt: /^https?:\/\//i.test(String(p.proofUrl ?? "")) ? { url: String(p.proofUrl), name: p.receiptNumber || `${method || "Payment"} receipt` } : null,
        };
      })
      .sort((a, b) => a.paidOn.localeCompare(b.paidOn)),
    updatedAt: (opts.at ?? new Date()).toISOString(),
    ...declaredSide(invoice),
  };
}

let kick: (() => void) | null = null;
/** The worker registers how to be woken, so a change goes out now rather than on the next tick. */
export function onFeeUpdateQueued(fn: () => void): void {
  kick = fn;
}

/**
 * Queue the invoice's money for CS Portal, if its student went there.
 * Pass the document for a deletion — it is gone from the database by the time
 * anybody could read it. Never throws, never waits on CS Portal.
 */
export async function queueFeeUpdate(
  invoiceOrId: InvoiceLike | string | Types.ObjectId,
  reason: string,
  opts: { deleted?: boolean; evenIfNotSent?: boolean } = {},
): Promise<boolean> {
  try {
    if (!commissionConfigured()) return false;
    const id = typeof invoiceOrId === "string" || invoiceOrId instanceof Types.ObjectId ? String(invoiceOrId) : String(invoiceOrId._id);
    if (!Types.ObjectId.isValid(id)) return false;
    const provision = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(id), "commission.state": "sent" })
      .select("organizationId commission lmsCourseTitle payload.email")
      .lean<ProvisionLike & { organizationId: unknown }>();
    // evenIfNotSent (the receipts backfill, 2026-10-12): an enrolment CS Portal has from before finance sent
    // students — it knows the invoice, and answers UNKNOWN_INVOICE (stopped, harmless) when it doesn't.
    if (!provision && !opts.evenIfNotSent) return false;

    const invoice: InvoiceLike | null = opts.deleted && typeof invoiceOrId === "object" && !(invoiceOrId instanceof Types.ObjectId)
      ? invoiceOrId
      : await Invoice.findById(id).lean<InvoiceLike>();
    if (!invoice) return false;
    const customer = invoice.customerId
      ? await Customer.findById(invoice.customerId).select("email").lean<{ email?: string } | null>()
      : null;
    const now = new Date();
    const payload = buildFeeUpdate(invoice, provision, customer?.email ?? "", { deleted: opts.deleted, at: now });

    await CommissionFeeUpdateModel.updateOne(
      { invoiceId: new Types.ObjectId(id) },
      {
        $set: {
          organizationId: invoice.organizationId ?? provision?.organizationId,
          invoiceNumber: invoice.invoiceNumber ?? "",
          payload,
          reason,
          state: "pending",
          queuedAt: now,
          attempts: 0,
          nextAttemptAt: now,
        },
        $unset: { lastError: 1, claimedAt: 1 },
      },
      { upsert: true },
    );
    kick?.();
    return true;
  } catch (err) {
    logger.error({ err, reason }, "Could not queue a fee update for CS Portal");
    return false;
  }
}

/** Backs off to a quarter of an hour and stays there, still trying. */
const backoffMs = (attempts: number) => Math.min(2 ** attempts * 1000, 15 * 60_000);
const STUCK_MS = 2 * 60_000;
const BATCH = 20;

/**
 * The worker's pass: every update whose time has come, and any left "sending"
 * by a pass that died part-way. Each claimed before it is sent; each outcome
 * written only if nothing newer was queued meanwhile.
 */
export async function drainFeeUpdates(now = new Date()): Promise<number> {
  if (!commissionConfigured()) return 0;
  const due = await CommissionFeeUpdateModel.find({
    $or: [
      { state: "pending", nextAttemptAt: { $lte: now } },
      { state: "sending", claimedAt: { $lt: new Date(now.getTime() - STUCK_MS) } },
    ],
  }).sort({ nextAttemptAt: 1 }).limit(BATCH).lean();

  let delivered = 0;
  for (const candidate of due) {
    const row = await CommissionFeeUpdateModel.findOneAndUpdate(
      { _id: candidate._id, state: candidate.state, queuedAt: candidate.queuedAt },
      { $set: { state: "sending", claimedAt: new Date() } },
      { new: true },
    ).lean();
    if (!row) continue;
    const same = { _id: row._id, queuedAt: row.queuedAt };
    const attempts = (row.attempts ?? 0) + 1;
    try {
      const result = await sendFeeUpdateToCommission(row.payload as CommissionFeeUpdate);
      await CommissionFeeUpdateModel.updateOne(same, {
        $set: { state: "delivered", deliveredAt: new Date(), attempts },
        $unset: { claimedAt: 1, lastError: 1 },
      });
      delivered++;
      logger.info({ invoice: row.invoiceNumber, applied: result.applied }, "Fee update delivered to CS Portal");
    } catch (err) {
      const message = ((err as Error).message || "CS Portal could not be reached").slice(0, 500);
      if (err instanceof CommissionRefusedError) {
        const stopped = err.code === "UNKNOWN_INVOICE";
        await CommissionFeeUpdateModel.updateOne(same, {
          $set: { state: stopped ? "stopped" : "failed", lastError: message, attempts },
          $unset: { claimedAt: 1 },
        });
        logger.warn({ invoice: row.invoiceNumber, code: err.code, reason: message }, stopped
          ? "CS Portal has no course fee for this invoice — fee update stopped"
          : "CS Portal refused a fee update");
        continue;
      }
      await CommissionFeeUpdateModel.updateOne(same, {
        $set: { state: "pending", lastError: message, attempts, nextAttemptAt: new Date(Date.now() + backoffMs(attempts)) },
        $unset: { claimedAt: 1 },
      });
      logger.warn({ invoice: row.invoiceNumber, attempts, err: message }, "Fee update not delivered yet — will retry");
    }
  }
  return delivered;
}
