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
    type: r.type === "BONUS" ? "BONUS" : "DEPOSIT",
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
    const what = bonus ? "bonus (course payment)" : "deposit";
    await sendNotice({
      to,
      subject: `${bonus ? "Bonus" : "Deposit"} to approve: ${d.student.name} — ${money(d.amountMinor, d.currency)}`,
      title: `A Tetra Commission ${what} is waiting for approval`,
      lines: [
        `${by ? `${by} raised` : "Tetra Commission sent"} a ${what} of ${money(d.amountMinor, d.currency)} for ${d.student.name}${d.student.code ? ` (${d.student.code})` : ""}.`,
        [d.coursePayment?.product, paidBy(d) && `Paid by ${paidBy(d)}`, d.mt5Login && `MT5 ${d.mt5Login}`, d.team && `Team ${d.team}`].filter(Boolean).join(" · "),
        bonus
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
      ...(input.type === "BONUS" && input.coursePayment ? { coursePayment: input.coursePayment } : {}),
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
      events: [{ at: new Date(), kind: "received", byName: input.requestedBy || input.initiatingMentor, text: input.type === "BONUS" ? "Bonus raised in Tetra Commission" : "Raised in Tetra Commission" }],
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
        ? "Approved — Tetra Commission has it, and the mentors' commission is credited"
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
            ? `Approved at ${money(input.amountMinor, "USD")}, transaction ${input.transactionId}`
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

  const outcome = await deliverDecision(row, true);
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
    if ((await deliverDecision(row, false)).kind === "delivered") delivered++;
  }
  return delivered;
}
