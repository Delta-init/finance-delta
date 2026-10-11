import { Types } from "mongoose";
import type {
  DecideTetraDepositInput, InboundTetraDeposit, PageMeta, TetraDeposit, TetraDepositCounts, TetraDepositDecisionResult,
  TetraDepositListQuery, TetraDepositView,
} from "@delta/shared";
import type { AuthContext } from "../../middleware/auth";
import { env } from "../../config/env";
import { AppError } from "../../lib/http";
import { logger } from "../../lib/logger";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { sendNotice } from "../../lib/email";
import { withAccountants } from "../../lib/approval-recipients";
import {
  commissionConfigured, sendFundingDecisionToCommission, CommissionRefusedError, type CommissionFundingDecision,
} from "../../lib/commission-client";
import { PAYMENT_METHODS, type PaymentMethod } from "@delta/shared";
import { Role } from "../role/role.model";
import { User } from "../user/user.model";
import { TetraDepositModel } from "./tetra-deposit.model";

/**
 * Deposit requests from Tetra Commission, decided here and sent back there.
 *
 * In: Tetra Commission hands each new deposit over (integrations/tetra-deposits,
 * signed), once however many times it retries, and the accountants are told.
 *
 * Decided: an accountant approves — at the amount that arrived, with its
 * transaction ID — or rejects with a reason, from the Approvals page. The
 * decision is sent back straight away, in the same request, so they learn at
 * once whether Tetra Commission took it. Refused because the transaction ID is
 * already used there, it is put back to pending for them to correct; gone from
 * Tetra Commission or decided there already, it is closed; unreachable, it is
 * kept and the worker (jobs/tetra-deposit.worker.ts) keeps sending it.
 */

const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : "");
const money = (minor: number, currency: string) =>
  `${currency} ${(minor / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** How it was paid: every payment's method — "CARD PAYMENT + Cash deposit" — or its one. */
const paidBy = (d: TetraDeposit) => (d.payments.length ? [...new Set(d.payments.map((p) => p.method))].join(" + ") : d.paymentMethod);

export function tetraDepositDTO(r: any, withEvents = false): TetraDeposit {
  return {
    id: String(r._id),
    externalId: String(r.externalId),
    type: r.type === "BONUS" || r.type === "COURSE_UPGRADE" || r.type === "ENROLMENT_PAYMENT" ? r.type : "DEPOSIT",
    status: r.status,
    amountMinor: r.amountMinor,
    currency: r.currency ?? "USD",
    ...(typeof r.amountOriginal === "number" && r.amountCurrency ? { amountOriginal: r.amountOriginal, amountCurrency: r.amountCurrency } : {}),
    ...(r.coursePayment
      ? {
          coursePayment: {
            product: r.coursePayment.product ?? "", kind: r.coursePayment.kind ?? "", withBonus: r.coursePayment.withBonus === true,
            bonusUsd: r.coursePayment.bonusUsd ?? null, holdAed: r.coursePayment.holdAed ?? null, balanceAed: r.coursePayment.balanceAed ?? null,
            paidTodayAed: r.coursePayment.paidTodayAed ?? null, paidBeforeAed: r.coursePayment.paidBeforeAed ?? null,
            price: r.coursePayment.price ?? null, priceCurrency: r.coursePayment.priceCurrency ?? "",
          },
        }
      : {}),
    student: {
      id: r.student?.id ?? "", code: r.student?.code ?? "", name: r.student?.name ?? "",
      email: r.student?.email ?? "", level: r.student?.level ?? "",
    },
    team: r.team ?? "",
    paymentMethod: r.paymentMethod ?? "",
    mt5Login: r.mt5Login ?? "",
    mt5Accounts: (r.mt5Accounts ?? []).map((a: any) => ({ login: String(a.login), platform: String(a.platform ?? "") })),
    screenshotUrl: r.screenshotUrl ?? "",
    payments: (r.payments ?? []).map((p: any) => ({
      method: String(p.method ?? ""), amountMinor: Number(p.amountMinor) || 0, currency: String(p.currency ?? ""),
      receiptUrl: String(p.receiptUrl ?? ""), receiptName: String(p.receiptName ?? ""),
    })),
    notes: r.notes ?? "",
    requestedAt: iso(r.requestedAt ?? r.createdAt),
    requestedBy: r.requestedBy ?? "",
    initiatingMentor: r.initiatingMentor ?? "",
    primaryMentor: r.primaryMentor ?? "",
    meetingMentor: r.meetingMentor ?? "",
    receivedAt: iso(r.createdAt),
    ...(r.decision?.decidedAt
      ? {
          decision: {
            ...(r.decision.approvedAmountMinor !== undefined ? { approvedAmountMinor: r.decision.approvedAmountMinor } : {}),
            ...(r.decision.transactionId ? { transactionId: r.decision.transactionId } : {}),
            ...(r.decision.paymentMethod ? { paymentMethod: r.decision.paymentMethod } : {}),
            ...(r.decision.mt5Login ? { mt5Login: r.decision.mt5Login } : {}),
            ...(r.decision.note ? { note: r.decision.note } : {}),
            ...(r.decision.reason ? { reason: r.decision.reason } : {}),
            decidedByName: r.decision.decidedByName ?? "",
            decidedAt: iso(r.decision.decidedAt),
          },
        }
      : {}),
    ...(r.delivery?.state
      ? {
          delivery: {
            state: r.delivery.state,
            attempts: r.delivery.attempts ?? 0,
            ...(r.delivery.lastError ? { lastError: r.delivery.lastError } : {}),
            ...(r.delivery.deliveredAt ? { deliveredAt: iso(r.delivery.deliveredAt) } : {}),
          },
        }
      : {}),
    ...(r.closedReason ? { closedReason: r.closedReason } : {}),
    ...(r.enrolmentPayment?.invoiceId
      ? {
          enrolmentPayment: {
            invoiceId: String(r.enrolmentPayment.invoiceId),
            invoiceNumber: String(r.enrolmentPayment.invoiceNumber ?? ""),
            method: String(r.enrolmentPayment.method ?? ""),
            paidOn: String(r.enrolmentPayment.paidOn ?? ""),
            receiptUrl: String(r.enrolmentPayment.receiptUrl ?? ""),
            receiptName: String(r.enrolmentPayment.receiptName ?? ""),
            cs: { name: String(r.enrolmentPayment.cs?.name ?? ""), email: String(r.enrolmentPayment.cs?.email ?? "") },
            ...(r.enrolmentPayment.invoice
              ? {
                  invoice: {
                    course: String(r.enrolmentPayment.invoice.course ?? ""), customerName: String(r.enrolmentPayment.invoice.customerName ?? ""),
                    currency: String(r.enrolmentPayment.invoice.currency ?? ""), totalMinor: Number(r.enrolmentPayment.invoice.totalMinor) || 0,
                    paidMinor: Number(r.enrolmentPayment.invoice.paidMinor) || 0, balanceMinor: Number(r.enrolmentPayment.invoice.balanceMinor) || 0,
                    dueDate: String(r.enrolmentPayment.invoice.dueDate ?? ""),
                  },
                }
              : {}),
            ...(r.enrolmentPayment.recorded?.paymentId
              ? { recorded: { paymentId: String(r.enrolmentPayment.recorded.paymentId), at: iso(r.enrolmentPayment.recorded.at), method: String(r.enrolmentPayment.recorded.method ?? "") } }
              : {}),
          },
        }
      : {}),
    ...(withEvents
      ? {
          events: (r.events ?? []).map((e: any) => ({
            at: iso(e.at), kind: String(e.kind ?? ""), byName: String(e.byName ?? ""), text: String(e.text ?? ""),
          })),
        }
      : {}),
  };
}

/* ── In ──────────────────────────────────────────────────────────────────── */

/**
 * Tell whoever can decide it — everyone holding tetra_deposit:approve, found
 * by the permission so a custom role granting it is included, and the
 * accountants. Never fails the handover it reports.
 */
async function notifyDepositWaiting(organizationId: string, d: TetraDeposit): Promise<void> {
  try {
    const orgId = new Types.ObjectId(organizationId);
    const roles = await Role.find({
      organizationId: orgId,
      $or: [{ permissions: "tetra_deposit:approve" }, { permissions: "*" }],
    }).select("_id");
    const approvers = roles.length
      ? await User.find({
          status: "active",
          memberships: {
            $elemMatch: { organizationId: orgId, roleId: { $in: roles.map((r) => r._id) }, status: { $nin: ["suspended", "invited"] } },
          },
        }).select("email")
      : [];
    const to = await withAccountants(orgId, approvers.map((u) => u.email as string).filter(Boolean));
    if (to.length === 0) {
      logger.warn({ organizationId, depositId: d.id }, "Tetra Commission deposit received but nobody here can approve it");
      return;
    }
    const by = d.requestedBy || d.initiatingMentor;
    const bonus = d.type === "BONUS";
    const upgrade = d.type === "COURSE_UPGRADE";
    const balancePayment = d.type === "ENROLMENT_PAYMENT";
    const what = balancePayment ? "balance payment" : upgrade ? "course upgrade payment" : bonus ? "bonus (course payment)" : "deposit";
    await sendNotice({
      log: { organizationId: organizationId, kind: "tetra_deposit_notice" },
      to,
      subject: `${balancePayment ? "Balance payment" : upgrade ? "Course payment" : bonus ? "Bonus" : "Deposit"} to approve: ${d.student.name} — ${money(d.amountMinor, d.currency)}`,
      title: `A Tetra Commission ${what} is waiting for approval`,
      lines: [
        `${by ? `${by} raised` : "Tetra Commission sent"} a ${what} of ${money(d.amountMinor, d.currency)} for ${d.student.name}${d.student.code ? ` (${d.student.code})` : ""}.`,
        [d.coursePayment?.product, d.enrolmentPayment && `Invoice ${d.enrolmentPayment.invoiceNumber}`, d.enrolmentPayment?.paidOn && `Paid on ${d.enrolmentPayment.paidOn}`,
          paidBy(d) && `Paid by ${paidBy(d)}`, d.mt5Login && `MT5 ${d.mt5Login}`, d.team && `Team ${d.team}`].filter(Boolean).join(" · "),
        balancePayment
          ? "Approving it records the payment on the student's invoice, which sets their next due date and updates Tetra Commission. Check it against the receipt first."
          : upgrade
          ? "Approving it confirms the payment towards their course upgrade; Tetra Commission then counts it and raises the MT5 bonus it earns. Check it against the receipt first."
          : bonus
          ? "Approving it confirms the payment; a broker admin in Tetra Commission then credits the bonus in MT5 and approves it there. Check it against the statement and the receipt first."
          : "Approving it records it in Tetra Commission and credits the mentors' commission, so check it against the statement first.",
      ].filter(Boolean),
      actionLabel: "Review it",
      actionUrl: `${env.WEB_ORIGIN}/approvals`,
    });
  } catch (err) {
    logger.error({ err, depositId: d.id }, "Could not notify Tetra Commission deposit approvers");
  }
}

export async function intakeTetraDeposit(organizationId: string, input: InboundTetraDeposit): Promise<TetraDeposit> {
  // Without the way back, a decision here would never reach Tetra Commission.
  // Refused as unavailable, which Tetra Commission waits out rather than
  // taking as a final no.
  if (!commissionConfigured()) {
    throw new AppError("UNAVAILABLE", "Tetra Commission is not connected on this finance server, so its deposits cannot be decided here yet");
  }
  // The unique key on Tetra Commission's id is what makes a retry safe; wait
  // for it to be built (a no-op once it is).
  await TetraDepositModel.init();
  // A balance payment is decided by the organization its invoice is in — a
  // Bangalore enrolment's by Bangalore's accounts — whichever one Tetra
  // Commission's link names.
  if (input.type === "ENROLMENT_PAYMENT") {
    // A retry finds what it made, wherever that is — before the invoice is
    // checked again, since an approved one has changed the balance.
    const made = await TetraDepositModel.findOne({ externalId: input.externalId, type: "ENROLMENT_PAYMENT" }).lean();
    if (made) return tetraDepositDTO(made);
  }
  const balance = input.type === "ENROLMENT_PAYMENT" ? await enrolmentPaymentIntake(input) : null;
  if (balance) organizationId = balance.organizationId;
  const orgObjectId = new Types.ObjectId(organizationId);
  const key = { organizationId: orgObjectId, externalId: input.externalId };
  const existing = await TetraDepositModel.findOne(key).lean();
  if (existing) return tetraDepositDTO(existing);

  const requestedAt = input.requestedAt && !Number.isNaN(Date.parse(input.requestedAt)) ? new Date(input.requestedAt) : new Date();
  let row;
  try {
    row = await TetraDepositModel.create({
      organizationId: orgObjectId,
      externalId: input.externalId,
      status: "pending",
      amountMinor: input.amountMinor,
      currency: input.currency,
      student: input.student,
      team: input.team,
      type: input.type,
      ...(input.amountOriginal && input.amountCurrency ? { amountOriginal: input.amountOriginal, amountCurrency: input.amountCurrency } : {}),
      ...(input.type !== "DEPOSIT" && input.coursePayment ? { coursePayment: input.coursePayment } : {}),
      paymentMethod: input.paymentMethod,
      mt5Login: input.mt5Login,
      mt5Accounts: input.mt5Accounts,
      screenshotUrl: input.screenshotUrl,
      ...(input.payments.length ? { payments: input.payments } : {}),
      notes: input.notes,
      requestedAt,
      requestedBy: input.requestedBy,
      initiatingMentor: input.initiatingMentor,
      primaryMentor: input.primaryMentor,
      meetingMentor: input.meetingMentor,
      ...(balance ? { enrolmentPayment: balance.enrolmentPayment } : {}),
      events: [{
        at: new Date(), kind: "received", byName: input.requestedBy || input.initiatingMentor,
        text: input.type === "BONUS" ? "Bonus raised in Tetra Commission"
          : input.type === "COURSE_UPGRADE" ? "Course upgrade payment from Tetra Commission"
          : input.type === "ENROLMENT_PAYMENT" ? `Balance payment recorded in Tetra Commission${balance?.enrolmentPayment.cs.name ? ` by ${balance.enrolmentPayment.cs.name}` : ""}`
          : "Raised in Tetra Commission",
      }],
    });
  } catch (error) {
    // Two deliveries of the same request racing past the lookup: the unique
    // key lets one in, and the other gets the one that won.
    if ((error as { code?: number }).code !== 11000) throw error;
    const raced = await TetraDepositModel.findOne(key).lean();
    if (!raced) throw error;
    return tetraDepositDTO(raced);
  }

  const dto = tetraDepositDTO(row.toObject());
  logger.info({ depositId: dto.id, externalId: dto.externalId, student: dto.student.name }, "Tetra Commission deposit received for approval");
  void notifyDepositWaiting(organizationId, dto);
  return dto;
}

/* ── Balance payments (ENROLMENT_PAYMENT) ────────────────────────────────── */

/**
 * Finance's payment method for what Tetra Commission called it. Exact slugs
 * and labels first, then the words a CS uses; anything else is "other" (the
 * method as typed stays in the payment's note). An EMI's terms are not asked
 * there, so it is never recorded as one.
 */
export function financeMethodFor(raw: string | undefined | null): PaymentMethod {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return "other";
  const slug = v.replace(/[\s/-]+/g, "_");
  if ((PAYMENT_METHODS as readonly string[]).includes(slug) && slug !== "easebuzz_emi") return slug as PaymentMethod;
  if (/tabby/.test(v)) return "tabby";
  if (/tamara/.test(v)) return "tamara";
  if (/billex|smart invoice/.test(v)) return "billexpro";
  if (/cheque|check/.test(v)) return "cheque";
  if (/\binr\b|upi|rupee/.test(v)) return "inr_bank_account";
  if (/cash/.test(v)) return "cash";
  if (/card/.test(v)) return "card";
  if (/bank|transfer|wire|neft|imps|rtgs/.test(v)) return "bank_transfer";
  return "other";
}

/** The invoice a balance payment pays towards, as accounts read it on the request. */
async function invoiceForBalancePayment(invoiceId: string) {
  const { Invoice } = await import("../invoice/invoice.model");
  return Invoice.findById(invoiceId)
    .select("organizationId invoiceNumber customerName currency totalMinor amountPaidMinor balanceMinor status approval dueDate enrolment.course external.source")
    .lean<any>();
}

/** Why this balance payment cannot be recorded on the invoice as it stands, or null. */
function balancePaymentRefusal(invoice: any, amountMinor: number, currency: string): string | null {
  if (!invoice) return "The invoice it pays towards is not in finance (deleted?)";
  const n = invoice.invoiceNumber;
  if (invoice.status === "void") return `Invoice ${n} is void`;
  if (invoice.approval?.state !== "approved") return `Invoice ${n} is not approved yet`;
  const cur = invoice.currency ?? "AED";
  if (currency && currency !== cur) return `Invoice ${n} is in ${cur}, the payment in ${currency}`;
  const balance = invoice.balanceMinor ?? 0;
  if (balance <= 0) return `Invoice ${n} is already paid in full`;
  if (amountMinor > balance) return `${money(amountMinor, cur)} is more than the balance of ${money(balance, cur)} on invoice ${n}`;
  return null;
}

/**
 * Checks a balance payment as it arrives: an invoice whose student went to
 * Tetra Commission, still owing at least this much in this currency. Refused
 * with the reason otherwise — the CS sees it at once. Answers the invoice's
 * organization and what the row keeps.
 */
async function enrolmentPaymentIntake(input: InboundTetraDeposit) {
  const ep = input.enrolmentPayment!;
  const invoice = await invoiceForBalancePayment(ep.invoiceId);
  if (!invoice) throw new AppError("NOT_FOUND", "No such invoice in finance — the payment cannot be recorded against it");
  const { LmsProvision } = await import("../integrations/lms-provision.model");
  const sentThere = await LmsProvision.exists({ invoiceId: invoice._id, "commission.state": "sent" });
  if (!sentThere) throw new AppError("VALIDATION_ERROR", `Invoice ${invoice.invoiceNumber}'s student was not sent to Tetra Commission by finance`);
  const refusal = balancePaymentRefusal(invoice, input.amountMinor, input.currency);
  if (refusal) throw new AppError("CONFLICT", refusal);
  const { isoDay } = await import("../invoice/instalments");
  return {
    organizationId: String(invoice.organizationId),
    enrolmentPayment: {
      invoiceId: invoice._id,
      invoiceNumber: invoice.invoiceNumber,
      method: ep.method || input.paymentMethod,
      paidOn: ep.paidOn,
      receiptUrl: ep.receiptUrl || input.screenshotUrl,
      receiptName: ep.receiptName,
      cs: { name: ep.cs?.name || input.requestedBy, email: ep.cs?.email ?? "" },
      invoice: {
        course: invoice.enrolment?.course ?? "", customerName: invoice.customerName ?? "", currency: invoice.currency ?? "AED",
        totalMinor: invoice.totalMinor ?? 0, paidMinor: invoice.amountPaidMinor ?? 0, balanceMinor: invoice.balanceMinor ?? 0,
        dueDate: invoice.dueDate ? isoDay(new Date(invoice.dueDate)) : "",
      },
    },
  };
}

/**
 * Records an approved balance payment on its invoice, through recordPayment —
 * the same path as accounts' own, so the next due date and Tetra Commission's
 * fee update follow. Idempotent on the request (`tetra:<id>`): a retry after
 * this got part-way records nothing twice. Answers why not, when it could not.
 */
async function recordBalancePayment(row: any): Promise<{ ok: true } | { ok: false; message: string }> {
  const ep = row.enrolmentPayment;
  if (!ep?.invoiceId) return { ok: false, message: "The request names no invoice" };
  if (ep.recorded?.paymentId) return { ok: true };
  const d = row.decision ?? {};
  const externalRef = `tetra:${row.externalId}`;
  try {
    const invoice = await invoiceForBalancePayment(String(ep.invoiceId));
    if (!invoice) return { ok: false, message: "The invoice it pays towards is not in finance (deleted?)" };
    const method = d.paymentMethod && (PAYMENT_METHODS as readonly string[]).includes(d.paymentMethod) && d.paymentMethod !== "easebuzz_emi"
      ? (d.paymentMethod as PaymentMethod)
      : financeMethodFor(d.paymentMethod || ep.method);
    const { recordPayment } = await import("../invoice/invoice.service");
    await recordPayment(String(invoice.organizationId), String(ep.invoiceId), {
      method,
      amountMinor: d.approvedAmountMinor ?? row.amountMinor,
      paidOn: ep.paidOn,
      reference: String(d.transactionId ?? ""),
      notes: [
        `Recorded in Tetra Commission${ep.cs?.name ? ` by ${ep.cs.name}` : ""}${ep.method ? ` (${ep.method})` : ""}`,
        `approved by ${d.decidedByName || "accounts"}`,
        d.note,
      ].filter(Boolean).join(" · ").slice(0, 1000),
      accountName: "",
      chargesMinor: 0,
    }, undefined, { externalRef, proofUrl: ep.receiptUrl || row.screenshotUrl || "" });
    const { Invoice } = await import("../invoice/invoice.model");
    const after = await Invoice.findById(ep.invoiceId).select("payments._id payments.externalRef").lean<any>();
    const payment = (after?.payments ?? []).find((p: any) => p.externalRef === externalRef);
    await TetraDepositModel.updateOne({ _id: row._id }, {
      $set: { "enrolmentPayment.recorded": { paymentId: String(payment?._id ?? ""), at: new Date(), method } },
      $push: { events: { at: new Date(), kind: "recorded", byName: "", text: `Recorded on invoice ${invoice.invoiceNumber} — ${money(d.approvedAmountMinor ?? row.amountMinor, invoice.currency ?? "AED")}, paid on ${ep.paidOn}` } },
    });
    return { ok: true };
  } catch (err) {
    if (err instanceof AppError) return { ok: false, message: err.message };
    throw err;
  }
}

/** Back to pending, decision undone, with why — a balance payment that could not be recorded. */
async function putBack(row: any, message: string): Promise<void> {
  await TetraDepositModel.updateOne({ _id: row._id }, {
    $set: { status: "pending" },
    $unset: { decision: "", delivery: "" },
    $push: { events: { at: new Date(), kind: "returned", byName: "", text: `Not recorded on the invoice: ${message}` } },
  });
}

/* ── Read ────────────────────────────────────────────────────────────────── */

/**
 * waiting    for a decision, newest first
 * attention  decided, but Tetra Commission does not have it yet — on its way,
 *            or turned down (reopen it)
 * decided    the latest decisions
 */
export async function listTetraDeposits(organizationId: string, view: TetraDepositView): Promise<TetraDeposit[]> {
  const org = new Types.ObjectId(organizationId);
  const rows = view === "waiting"
    ? await TetraDepositModel.find({ organizationId: org, status: "pending" }).sort({ requestedAt: -1, createdAt: -1 }).limit(200).lean()
    : view === "attention"
      ? await TetraDepositModel.find({
          organizationId: org, status: { $in: ["approved", "rejected"] }, "delivery.state": { $in: ["sending", "queued", "failed"] },
        }).sort({ "decision.decidedAt": -1 }).limit(100).lean()
      : await TetraDepositModel.find({ organizationId: org, status: { $in: ["approved", "rejected", "closed"] } })
          .sort({ "decision.decidedAt": -1, updatedAt: -1 }).limit(50).lean();
  return rows.map((r) => tetraDepositDTO(r));
}

/**
 * Every deposit Tetra Commission sent, for the deposits page: by status,
 * searched, between two instants of being raised, sorted and paged — with how
 * many there are of each status under the same search and dates, for its tabs.
 */
const LIST_SORTS = {
  requestedAt: "requestedAt", student: "student.name", amount: "amountMinor", decidedAt: "decision.decidedAt", status: "status",
};

export async function listTetraDepositPage(
  organizationId: string,
  query: TetraDepositListQuery,
): Promise<{ data: TetraDeposit[]; meta: PageMeta & { counts: TetraDepositCounts } }> {
  const base: Record<string, unknown> = { organizationId: new Types.ObjectId(organizationId) };
  const or = searchOr(query.q, [
    "student.name", "student.code", "student.email", "decision.transactionId", "mt5Login", "decision.mt5Login",
    "requestedBy", "initiatingMentor", "primaryMentor", "team", "paymentMethod",
  ]);
  if (or) base.$or = or;
  if (query.from || query.to) {
    base.requestedAt = { ...(query.from ? { $gte: new Date(query.from) } : {}), ...(query.to ? { $lt: new Date(query.to) } : {}) };
  }
  const filter = query.status === "all" ? base : { ...base, status: query.status };
  const sort = buildSort(LIST_SORTS, query.sort, query.dir, { requestedAt: -1, createdAt: -1 });

  const [rows, total, groups] = await Promise.all([
    TetraDepositModel.find(filter).sort({ ...sort, _id: -1 }).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize).lean(),
    TetraDepositModel.countDocuments(filter),
    TetraDepositModel.aggregate<{ _id: string; n: number }>([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
  ]);
  const counts: TetraDepositCounts = { all: 0, pending: 0, approved: 0, rejected: 0, closed: 0 };
  for (const g of groups) {
    if (g._id in counts) counts[g._id as keyof TetraDepositCounts] = g.n;
    counts.all += g.n;
  }
  return { data: rows.map((r) => tetraDepositDTO(r)), meta: { ...pageMeta(total, query.page, query.pageSize), counts } };
}

/** One deposit, with what happened to it here. */
export async function getTetraDeposit(organizationId: string, id: string): Promise<TetraDeposit> {
  if (!Types.ObjectId.isValid(id)) throw new AppError("NOT_FOUND", "Deposit request not found");
  const row = await TetraDepositModel.findOne({ _id: id, organizationId: new Types.ObjectId(organizationId) }).lean();
  if (!row) throw new AppError("NOT_FOUND", "Deposit request not found");
  return tetraDepositDTO(row, true);
}

/* ── Decided, and sent back ──────────────────────────────────────────────── */

/** Backs off to a quarter of an hour and stays there, still trying. */
const backoffMs = (attempts: number) => Math.min(2 ** attempts * 1000, 15 * 60_000);

function decisionFor(row: any): CommissionFundingDecision {
  const d = row.decision ?? {};
  return {
    fundingId: String(row.externalId),
    financeId: String(row._id),
    decision: row.status === "approved" ? "approved" : "rejected",
    ...(row.status === "approved"
      ? {
          amountMinor: d.approvedAmountMinor,
          transactionId: d.transactionId,
          ...(d.paymentMethod ? { paymentMethod: d.paymentMethod } : {}),
          ...(d.mt5Login ? { mt5Login: d.mt5Login } : {}),
          ...(d.note ? { note: d.note } : {}),
        }
      : { reason: d.reason }),
    ...(row.type === "ENROLMENT_PAYMENT" && row.enrolmentPayment?.invoiceId
      ? {
          type: "ENROLMENT_PAYMENT" as const,
          invoiceId: String(row.enrolmentPayment.invoiceId),
          paidOn: String(row.enrolmentPayment.paidOn ?? ""),
          ...(row.enrolmentPayment.recorded?.paymentId ? { paymentId: String(row.enrolmentPayment.recorded.paymentId) } : {}),
        }
      : {}),
    decidedBy: { name: String(d.decidedByName ?? ""), email: String(d.decidedByEmail ?? "") },
    decidedAt: iso(d.decidedAt) || new Date().toISOString(),
  };
}

type Delivered =
  | { kind: "delivered"; message: string }
  | { kind: "queued"; message: string }
  | { kind: "closed"; message: string }
  | { kind: "failed"; message: string }
  /** Only when asked to leave it to the caller: a refusal the accountant can put right. */
  | { kind: "correctable"; message: string };

/**
 * Send one decision, claimed as "sending" by the caller, and record what came
 * of it. `putBackCorrectable`: the accountant is waiting on the answer, so a
 * refusal they can put right (a transaction ID already used) is left to the
 * caller, which puts the request back to pending in front of them.
 */
async function deliverDecision(row: any, putBackCorrectable: boolean): Promise<Delivered> {
  const attempts = (row.delivery?.attempts ?? 0) + 1;
  const event = (kind: string, text: string) => ({ events: { at: new Date(), kind, byName: "", text } });
  try {
    const result = await sendFundingDecisionToCommission(decisionFor(row));
    await TetraDepositModel.updateOne({ _id: row._id }, {
      $set: { "delivery.state": "delivered", "delivery.deliveredAt": new Date(), "delivery.attempts": attempts },
      $unset: { "delivery.nextAttemptAt": "", "delivery.claimedAt": "", "delivery.lastError": "" },
      $push: event("delivered", row.status === "approved"
        ? `Approved in Tetra Commission${result.credited ? `; commission credited (${result.credited} line${result.credited === 1 ? "" : "s"})` : ""}${result.levelUpgraded ? "; the student moved to Level 2" : ""}`
        : "Rejected in Tetra Commission"),
    });
    logger.info({ depositId: String(row._id), decision: row.status, repeat: result.already }, "Deposit decision delivered to Tetra Commission");
    return {
      kind: "delivered",
      message: row.status === "approved"
        ? row.type === "ENROLMENT_PAYMENT"
          ? `Approved — recorded on invoice ${row.enrolmentPayment?.invoiceNumber ?? ""}, and Tetra Commission has it`
          : "Approved — Tetra Commission has it, and the mentors' commission is credited"
        : "Rejected — Tetra Commission has it",
    };
  } catch (err) {
    if (err instanceof CommissionRefusedError) {
      // Nothing left to decide: gone from Tetra Commission, decided there, or never finance's.
      if (err.status === 410 || err.code === "ALREADY_DECIDED" || err.code === "NOT_WITH_FINANCE") {
        await TetraDepositModel.updateOne({ _id: row._id }, {
          $set: { status: "closed", closedReason: err.message, "delivery.state": "failed", "delivery.lastError": err.message, "delivery.attempts": attempts },
          $unset: { "delivery.nextAttemptAt": "", "delivery.claimedAt": "" },
          $push: event("closed", `Closed: ${err.message}`),
        });
        logger.warn({ depositId: String(row._id), reason: err.message }, "Deposit request closed — nothing left to decide in Tetra Commission");
        return { kind: "closed", message: `Closed — ${err.message}` };
      }
      if (putBackCorrectable) return { kind: "correctable", message: err.message };
      await TetraDepositModel.updateOne({ _id: row._id }, {
        $set: { "delivery.state": "failed", "delivery.lastError": err.message, "delivery.attempts": attempts },
        $unset: { "delivery.nextAttemptAt": "", "delivery.claimedAt": "" },
        $push: event("failed", `Tetra Commission did not accept it: ${err.message}`),
      });
      logger.warn({ depositId: String(row._id), reason: err.message }, "Tetra Commission did not accept a deposit decision");
      return { kind: "failed", message: err.message };
    }
    const message = (err as Error).message || "Tetra Commission could not be reached";
    await TetraDepositModel.updateOne({ _id: row._id }, {
      $set: {
        "delivery.state": "queued", "delivery.attempts": attempts, "delivery.lastError": message,
        "delivery.nextAttemptAt": new Date(Date.now() + backoffMs(attempts)),
      },
      $unset: { "delivery.claimedAt": "" },
    });
    logger.warn({ depositId: String(row._id), attempts, err: message }, "Deposit decision not delivered yet — will retry");
    return { kind: "queued", message: `Saved. Tetra Commission could not be reached just now (${message}) — it will be updated automatically.` };
  }
}

export async function decideTetraDeposit(auth: AuthContext, id: string, input: DecideTetraDepositInput): Promise<TetraDepositDecisionResult> {
  if (!Types.ObjectId.isValid(id)) throw new AppError("NOT_FOUND", "Deposit request not found");
  const org = new Types.ObjectId(auth.organizationId);
  const me = await User.findById(auth.userId).select("name email").lean();
  const byName = String(me?.name ?? "An accountant");
  // Its own currency in the history: a course payment is in AED, a deposit in USD.
  const current = await TetraDepositModel.findOne({ _id: id, organizationId: org }).select("currency type enrolmentPayment status").lean();
  if (current?.type === "ENROLMENT_PAYMENT" && current.status === "pending" && input.decision === "approved" && !current.enrolmentPayment?.recorded?.paymentId) {
    // Checked before anything changes: refused, it stays pending in front of them to correct or reject.
    const refusal = balancePaymentRefusal(await invoiceForBalancePayment(String(current.enrolmentPayment?.invoiceId)), input.amountMinor, current.currency ?? "");
    if (refusal) throw new AppError("CONFLICT", `Not recorded: ${refusal}`);
  }
  const now = new Date();
  const decided = { decidedById: new Types.ObjectId(auth.userId), decidedByName: byName, decidedByEmail: String(me?.email ?? ""), decidedAt: now };
  const decision = input.decision === "approved"
    ? { ...decided, approvedAmountMinor: input.amountMinor, transactionId: input.transactionId, paymentMethod: input.paymentMethod, mt5Login: input.mt5Login, note: input.note }
    : { ...decided, reason: input.reason };

  // One decision per request, whoever gets there first — claimed for sending in the same write.
  const row = await TetraDepositModel.findOneAndUpdate(
    { _id: id, organizationId: org, status: "pending" },
    {
      $set: { status: input.decision, decision, delivery: { state: "sending", attempts: 0, claimedAt: now } },
      $push: {
        events: {
          at: now, kind: input.decision, byName,
          text: input.decision === "approved"
            ? `Approved at ${money(input.amountMinor, current?.currency ?? "USD")}, transaction ${input.transactionId}`
            : `Rejected: ${input.reason}`,
        },
      },
    },
    { new: true },
  ).lean();
  if (!row) {
    const other = await TetraDepositModel.findOne({ _id: id, organizationId: org }).select("status").lean();
    if (!other) throw new AppError("NOT_FOUND", "Deposit request not found");
    throw new AppError("CONFLICT", `This deposit request is already ${other.status}`);
  }

  let toDeliver: any = row;
  if (row.type === "ENROLMENT_PAYMENT" && row.status === "approved") {
    // The payment goes on the invoice first; only then does Tetra Commission hear it was approved.
    const recorded = await recordBalancePayment(row);
    if (!recorded.ok) {
      await putBack(row, recorded.message);
      throw new AppError("CONFLICT", `Not recorded: ${recorded.message}`);
    }
    toDeliver = await TetraDepositModel.findById(row._id).lean();
  }

  // A balance payment is on the invoice by now, so a refusal there is not put back in front of
  // them to decide again: it is kept as not delivered, to reopen, like the worker's.
  const outcome = await deliverDecision(toDeliver, row.type !== "ENROLMENT_PAYMENT");
  if (outcome.kind === "correctable") {
    // Turned down for something they can put right: back in front of them, as it was.
    await TetraDepositModel.updateOne({ _id: row._id }, {
      $set: { status: "pending" },
      $unset: { decision: "", delivery: "" },
      $push: { events: { at: new Date(), kind: "returned", byName: "", text: `Tetra Commission did not accept it: ${outcome.message}` } },
    });
    throw new AppError("CONFLICT", `Tetra Commission did not accept it: ${outcome.message}`);
  }
  const fresh = await TetraDepositModel.findById(row._id).lean();
  return { deposit: tetraDepositDTO(fresh), delivered: outcome.kind === "delivered", message: outcome.message };
}

/** A decision Tetra Commission turned down, back to pending to decide again. */
export async function reopenTetraDeposit(auth: AuthContext, id: string): Promise<TetraDeposit> {
  if (!Types.ObjectId.isValid(id)) throw new AppError("NOT_FOUND", "Deposit request not found");
  const org = new Types.ObjectId(auth.organizationId);
  const me = await User.findById(auth.userId).select("name").lean();
  const row = await TetraDepositModel.findOneAndUpdate(
    { _id: id, organizationId: org, status: { $in: ["approved", "rejected"] }, "delivery.state": "failed" },
    {
      $set: { status: "pending" },
      $unset: { decision: "", delivery: "" },
      $push: { events: { at: new Date(), kind: "reopened", byName: String(me?.name ?? ""), text: "Reopened to decide again" } },
    },
    { new: true },
  ).lean();
  if (!row) {
    const other = await TetraDepositModel.findOne({ _id: id, organizationId: org }).select("_id").lean();
    if (!other) throw new AppError("NOT_FOUND", "Deposit request not found");
    throw new AppError("CONFLICT", "Only a decision Tetra Commission turned down can be reopened");
  }
  return tetraDepositDTO(row);
}

/**
 * The worker's pass: every decision not yet delivered whose time has come,
 * and any left "sending" by a request that died part-way. Each is claimed
 * before it is sent, so this and an accountant's own request never send the
 * same one at once.
 */
const STUCK_MS = 2 * 60_000;

export async function drainTetraDepositDecisions(): Promise<number> {
  if (!commissionConfigured()) return 0;
  const now = new Date();
  const due = await TetraDepositModel.find({
    status: { $in: ["approved", "rejected"] },
    $or: [
      { "delivery.state": "queued", "delivery.nextAttemptAt": { $lte: now } },
      { "delivery.state": "sending", "delivery.claimedAt": { $lt: new Date(now.getTime() - STUCK_MS) } },
    ],
  }).sort({ "delivery.nextAttemptAt": 1 }).limit(20).lean();

  let delivered = 0;
  for (const candidate of due) {
    const claim = candidate.delivery?.state === "queued"
      ? { "delivery.state": "queued", "delivery.nextAttemptAt": candidate.delivery.nextAttemptAt }
      : { "delivery.state": "sending", "delivery.claimedAt": candidate.delivery?.claimedAt };
    const row = await TetraDepositModel.findOneAndUpdate(
      { _id: candidate._id, ...claim },
      { $set: { "delivery.state": "sending", "delivery.claimedAt": new Date() } },
      { new: true },
    ).lean();
    if (!row) continue;
    let toDeliver: any = row;
    if (row.type === "ENROLMENT_PAYMENT" && row.status === "approved" && !row.enrolmentPayment?.recorded?.paymentId) {
      // Approved by a request that died before the payment was recorded: record it now, or hand it back.
      const recorded = await recordBalancePayment(row);
      if (!recorded.ok) {
        await putBack(row, recorded.message);
        continue;
      }
      toDeliver = await TetraDepositModel.findById(row._id).lean();
    }
    if ((await deliverDecision(toDeliver, false)).kind === "delivered") delivered++;
  }
  return delivered;
}
