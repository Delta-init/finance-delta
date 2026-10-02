import { Types, type Model, type PipelineStage } from "mongoose";
import {
  hasPermission,
  type ApprovalCommission, type ApprovalGroup, type ApprovalItem, type ApprovalListQuery, type ApprovalListStatus,
  type ApprovalLms, type ApprovalRow, type ApprovalSummary, type ApprovalType, type Permission,
} from "@delta/shared";
import type { AuthContext } from "../../middleware/auth";
import { logger } from "../../lib/logger";
import { hrmsClient, type HrmsProcurementRequest } from "../../lib/hrms-client";
import { Invoice } from "../invoice/invoice.model";
import { Expense } from "../expense/expense.model";
import { Bill } from "../bill/bill.model";
import { PayrollRun } from "../payroll/payroll-run.model";
import { PayrollOrgLink } from "../payroll-mapping/org-link.model";
import { FundingRequestModel } from "../budget/budget.model";
import { TetraDepositModel } from "../tetra-deposit/tetra-deposit.model";
import { Department } from "../department/department.model";
import { User } from "../user/user.model";
import { LmsProvision } from "../integrations/lms-provision.model";

/**
 * What is waiting on this person, across every kind of approval.
 *
 * Each kind is gated by the permission that decides it, the same one its own
 * approve route demands — so a count never points somebody at a queue they
 * would only be refused on. Counted in parallel; one kind failing to read is
 * reported on that kind and does not take the others down with it.
 */

const LATEST = 5;
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : undefined);

function monthName(period: string): string {
  return new Date(`${period}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

type Kind = {
  type: ApprovalGroup["type"];
  label: string;
  href: string;
  /** Any one of these lets you decide it — all of them, for the "and" cases. */
  allowed: (can: (p: Permission) => boolean) => boolean;
  read: (org: Types.ObjectId, auth: AuthContext) => Promise<{ count: number; items: ApprovalItem[] }>;
};

const KINDS: Kind[] = [
  {
    type: "invoice",
    label: "Enrolment invoices",
    href: "/approvals",
    // Deciding is one permission and reading the queue is another.
    allowed: (can) => can("invoice:write") && can("invoice:read"),
    read: async (org) => {
      const filter = { organizationId: org, "approval.state": "pending" };
      const [count, rows] = await Promise.all([
        Invoice.countDocuments(filter),
        Invoice.find(filter).sort({ "approval.submittedAt": -1, createdAt: -1 }).limit(LATEST)
          .select("invoiceNumber customerName salespersonName totalMinor currency approval.submittedAt enrolment.course createdAt").lean(),
      ]);
      return {
        count,
        items: rows.map((r: any) => ({
          id: String(r._id),
          title: r.customerName ?? r.invoiceNumber,
          subtitle: [r.enrolment?.course, r.invoiceNumber, r.salespersonName].filter(Boolean).join(" · "),
          amountMinor: r.totalMinor ?? 0, currency: r.currency ?? "AED",
          at: iso(r.approval?.submittedAt ?? r.createdAt), href: `/invoices/${r._id}`,
        })),
      };
    },
  },
  {
    type: "fund_request",
    label: "Fund requests",
    href: "/approvals",
    allowed: (can) => can("budget:approve"),
    read: async (org, auth) => {
      // Not your own top-up: nobody may approve their own request, so it is
      // not waiting on you.
      const filter = { organizationId: org, status: "submitted", requestedById: { $ne: new Types.ObjectId(auth.userId) } };
      const [count, rows] = await Promise.all([
        FundingRequestModel.countDocuments(filter),
        FundingRequestModel.find(filter).sort({ createdAt: -1 }).limit(LATEST).populate("departmentId", "name").lean(),
      ]);
      return {
        count,
        items: rows.map((r: any) => ({
          id: String(r._id),
          title: r.title,
          subtitle: [
            r.departmentId?.name, monthName(r.period), r.requestedByName,
            r.external?.source === "media-erp" ? "Media ERP" : "", r.platform,
          ].filter(Boolean).join(" · "),
          amountMinor: r.amountMinor, currency: r.currency,
          at: iso(r.createdAt), href: "/approvals",
        })),
      };
    },
  },
  {
    type: "tetra_deposit",
    label: "Tetra Commission deposits",
    href: "/approvals",
    allowed: (can) => can("tetra_deposit:approve"),
    read: async (org) => {
      const filter = { organizationId: org, status: "pending" };
      const [count, rows] = await Promise.all([
        TetraDepositModel.countDocuments(filter),
        TetraDepositModel.find(filter).sort({ requestedAt: -1, createdAt: -1 }).limit(LATEST)
          .select("student amountMinor currency paymentMethod requestedBy initiatingMentor team requestedAt createdAt").lean(),
      ]);
      return {
        count,
        items: rows.map((r: any) => ({
          id: String(r._id),
          title: r.student?.name ?? "Deposit",
          subtitle: [r.student?.code, r.paymentMethod, r.requestedBy || r.initiatingMentor, r.team].filter(Boolean).join(" · "),
          amountMinor: r.amountMinor, currency: r.currency ?? "USD",
          at: iso(r.requestedAt ?? r.createdAt), href: "/approvals",
        })),
      };
    },
  },
  {
    type: "expense",
    label: "Expense claims",
    href: "/expenses?status=submitted",
    // As the dashboard's claims panel has it: approving alone cannot read the
    // queue it is meant to work through.
    allowed: (can) => can("expense:approve") && (can("expense:read") || can("expense:read:own")),
    read: async (org) => {
      const filter = { organizationId: org, status: "submitted" };
      const [count, rows] = await Promise.all([
        Expense.countDocuments(filter),
        Expense.find(filter).sort({ updatedAt: -1 }).limit(LATEST)
          .select("expenseNumber category description submittedByName totalMinor currency updatedAt createdAt").lean(),
      ]);
      return {
        count,
        items: rows.map((r: any) => ({
          id: String(r._id),
          title: r.description || r.category,
          subtitle: [r.expenseNumber, r.category, r.submittedByName].filter(Boolean).join(" · "),
          amountMinor: r.totalMinor ?? 0, currency: r.currency ?? "AED",
          at: iso(r.updatedAt ?? r.createdAt), href: `/expenses/${r._id}`,
        })),
      };
    },
  },
  {
    type: "bill",
    label: "Bills",
    href: "/bills",
    allowed: (can) => can("bill:approve"),
    read: async (org) => {
      const filter = { organizationId: org, status: "pending_approval" };
      const [count, rows] = await Promise.all([
        Bill.countDocuments(filter),
        Bill.find(filter).sort({ updatedAt: -1 }).limit(LATEST)
          .select("billNumber vendorName totalMinor currency dueDate updatedAt createdAt").lean(),
      ]);
      return {
        count,
        items: rows.map((r: any) => ({
          id: String(r._id),
          title: r.vendorName,
          subtitle: [r.billNumber, r.dueDate ? `due ${new Date(r.dueDate).toISOString().slice(0, 10)}` : ""].filter(Boolean).join(" · "),
          amountMinor: r.totalMinor ?? 0, currency: r.currency ?? "AED",
          at: iso(r.updatedAt ?? r.createdAt), href: `/bills/${r._id}`,
        })),
      };
    },
  },
  {
    type: "payroll",
    label: "Payroll runs",
    href: "/payroll/runs",
    allowed: (can) => can("payroll:approve"),
    read: async (org) => {
      // The two states its approve route accepts.
      const filter = { organizationId: org, status: { $in: ["imported", "additions"] } };
      const [count, rows] = await Promise.all([
        PayrollRun.countDocuments(filter),
        PayrollRun.find(filter).sort({ importedAt: -1 }).limit(LATEST)
          .select("runNumber period hrmsOrgName payableMinor hrmsNetMinor currency importedAt").lean(),
      ]);
      return {
        count,
        items: rows.map((r: any) => ({
          id: String(r._id),
          title: `${r.runNumber} · ${monthName(r.period)}`,
          subtitle: r.hrmsOrgName || "HRMS",
          amountMinor: r.payableMinor || r.hrmsNetMinor || 0, currency: r.currency ?? "AED",
          at: iso(r.importedAt), href: `/payroll/runs/${r._id}`,
        })),
      };
    },
  },
  {
    type: "procurement",
    label: "Purchase requests",
    href: "/procurement",
    allowed: (can) => can("expense:approve"),
    read: async (org) => {
      const links = await PayrollOrgLink.find({ organizationId: org, isActive: true }).select("hrmsOrgId hrmsOrgName").lean();
      const rows: Array<HrmsProcurementRequest & { from: string }> = [];
      let failed = 0;
      for (const link of links) {
        try {
          for (const r of await procurementRequests(String(link.hrmsOrgId))) rows.push({ ...r, from: String(link.hrmsOrgName ?? "") });
        } catch {
          failed++;
        }
      }
      // Every source unreadable is not "nothing waiting".
      if (links.length && failed === links.length) throw new Error("HRMS could not be reached");
      rows.sort((a, b) => String(b.hrReviewedAt ?? b.createdAt).localeCompare(String(a.hrReviewedAt ?? a.createdAt)));
      return {
        count: rows.length,
        items: rows.slice(0, LATEST).map((r) => ({
          id: r._id,
          title: `${r.quantity} × ${r.item}`,
          subtitle: [r.department?.name ?? r.from, r.requestedBy?.name].filter(Boolean).join(" · "),
          // HRMS keeps major units.
          amountMinor: Math.round((r.estimatedCost || 0) * 100), currency: r.currency || "AED",
          at: iso(r.hrReviewedAt ?? r.createdAt), href: "/procurement",
        })),
      };
    },
  },
];

/*
 * Purchase requests live in HRMS and are read live. Asked every minute by
 * every open sidebar, that would be a call to HRMS per tab per minute — so
 * the answer is kept for two minutes, failures included (a dead HRMS must not
 * make every sidebar wait out its timeout), and concurrent askers share one
 * call.
 */
const PROCUREMENT_TTL_MS = 2 * 60 * 1000;
const procurementCache = new Map<string, { at: number; value: Promise<HrmsProcurementRequest[]> }>();

/** A decision was just made: the next count asks HRMS again rather than showing it still waiting. */
export function forgetProcurementRequests(hrmsOrgId: string): void {
  procurementCache.delete(hrmsOrgId);
}

function procurementRequests(hrmsOrgId: string): Promise<HrmsProcurementRequest[]> {
  const hit = procurementCache.get(hrmsOrgId);
  if (hit && Date.now() - hit.at < PROCUREMENT_TTL_MS) return hit.value;
  const value = hrmsClient.procurementRequests(hrmsOrgId);
  procurementCache.set(hrmsOrgId, { at: Date.now(), value });
  return value;
}

export async function approvalSummary(auth: AuthContext): Promise<ApprovalSummary> {
  const can = (p: Permission) => auth.isSuperAdmin || hasPermission(auth.permissions, p);
  const org = new Types.ObjectId(auth.organizationId);
  const kinds = KINDS.filter((k) => k.allowed(can));

  const groups = await Promise.all(kinds.map(async (kind): Promise<ApprovalGroup> => {
    try {
      const { count, items } = await kind.read(org, auth);
      return { type: kind.type, label: kind.label, href: kind.href, count, items };
    } catch (err) {
      logger.warn({ err, type: kind.type }, "Approvals summary: one kind could not be read");
      return { type: kind.type, label: kind.label, href: kind.href, count: 0, items: [], unavailable: (err as Error).message || "Could not be read" };
    }
  }));

  return { total: groups.reduce((sum, g) => sum + g.count, 0), groups };
}

// ── Every approval, decided or not ───────────────────────────────────────────

/**
 * The Approvals page's table: every kind the reader may decide, waiting and
 * decided, newest first, in one list.
 *
 * Each kind is read on its own — from its own collection, its own states and
 * its own record of who decided it and when — and the pages are put together
 * here. A row's `at` is when it last happened: when it was decided, or while
 * it waits, when it was sent for a decision; the date range and the order are
 * both on it. To serve page N, each kind gives its newest N pages' worth at
 * most, so a later page costs more than the first but never reads a whole
 * collection. A kind that cannot be read is named in `unavailable` and the
 * others are still answered.
 *
 * Gated per kind by the same permission as the summary, so the table shows
 * exactly the kinds the summary counts.
 */

type ListCtx = {
  org: Types.ObjectId;
  me: string;
  status: ApprovalListStatus;
  range: { $gte?: Date; $lt?: Date } | null;
  limit: number;
};

type ListKind = {
  type: ApprovalType;
  label: string;
  allowed: (can: (p: Permission) => boolean) => boolean;
  list: (ctx: ListCtx) => Promise<{ total: number; rows: ApprovalRow[] }>;
};

/** The states of one kind that a status tab means. */
function statesFor(status: ApprovalListStatus, by: { pending: string[]; approved: string[]; rejected: string[]; other?: string[] }): string[] {
  return status === "all" ? [...by.pending, ...by.approved, ...by.rejected, ...(by.other ?? [])] : by[status];
}

/** The first of these fields a document has. */
const firstOf = (...fields: string[]): unknown =>
  fields.slice(0, -1).reduceRight<unknown>((rest, f) => ({ $ifNull: [f, rest] }), fields[fields.length - 1]);

/**
 * One kind's rows: those matching `match`, with `at` worked out per row by
 * `at`, inside the date range, newest first — at most `limit` of them, only
 * `fields` of each — and how many match in all.
 */
async function newest(
  model: Model<any>,
  match: Record<string, unknown>,
  at: unknown,
  fields: string,
  ctx: ListCtx,
): Promise<{ docs: any[]; total: number }> {
  const head: PipelineStage[] = [{ $match: match }, { $addFields: { __at: at as PipelineStage.AddFields["$addFields"][string] } }];
  if (ctx.range) head.push({ $match: { __at: ctx.range } });
  const project = Object.fromEntries(["__at", ...fields.split(/\s+/).filter(Boolean)].map((f) => [f, 1]));
  const [docs, counted] = await Promise.all([
    model.aggregate([...head, { $sort: { __at: -1, _id: -1 } }, { $limit: ctx.limit }, { $project: project }]),
    model.aggregate([...head, { $count: "n" }]),
  ]);
  return { docs, total: counted[0]?.n ?? 0 };
}

const inRange = (value: string | undefined, range: ListCtx["range"]) => {
  if (!range) return true;
  if (!value) return false;
  const t = new Date(value).getTime();
  return (!range.$gte || t >= range.$gte.getTime()) && (!range.$lt || t < range.$lt.getTime());
};

const LIST_KINDS: ListKind[] = [
  {
    type: "invoice",
    label: "Enrolment invoices",
    allowed: (can) => can("invoice:write") && can("invoice:read"),
    list: async (ctx) => {
      const states = statesFor(ctx.status, { pending: ["pending"], approved: ["approved"], rejected: ["returned"] });
      const { docs, total } = await newest(
        Invoice,
        { organizationId: ctx.org, "approval.state": { $in: states } },
        // Waiting: since it was sent. Decided: when it was — a resubmitted
        // invoice keeps its last decision's time until it is decided again.
        { $cond: [{ $eq: ["$approval.state", "pending"] }, firstOf("$approval.submittedAt", "$createdAt"), firstOf("$approval.at", "$approval.submittedAt", "$createdAt")] },
        "invoiceNumber customerName salespersonName totalMinor currency approval enrolment.course createdAt",
        ctx,
      );
      return {
        total,
        rows: docs.map((r): ApprovalRow => {
          const state = r.approval?.state as string;
          const decided = state !== "pending";
          return {
            id: String(r._id),
            type: "invoice",
            title: r.customerName ?? r.invoiceNumber,
            subtitle: [r.enrolment?.course, r.invoiceNumber].filter(Boolean).join(" · "),
            amountMinor: r.totalMinor ?? 0,
            currency: r.currency ?? "AED",
            raisedBy: r.salespersonName || undefined,
            status: state === "returned" ? "returned" : state === "approved" ? "approved" : "pending",
            at: iso(r.__at),
            submittedAt: iso(r.approval?.submittedAt ?? r.createdAt),
            decidedAt: decided ? iso(r.approval?.at) : undefined,
            decidedBy: decided ? r.approval?.byName || undefined : undefined,
            reason: state === "returned" ? r.approval?.returnedReason || undefined : undefined,
            href: `/invoices/${r._id}`,
          };
        }),
      };
    },
  },
  {
    type: "fund_request",
    label: "Fund requests",
    allowed: (can) => can("budget:approve"),
    list: async (ctx) => {
      const states = statesFor(ctx.status, { pending: ["submitted"], approved: ["approved"], rejected: ["rejected"] });
      const { docs, total } = await newest(
        FundingRequestModel,
        { organizationId: ctx.org, status: { $in: states } },
        { $cond: [{ $eq: ["$status", "submitted"] }, "$createdAt", firstOf("$reviewedAt", "$updatedAt")] },
        "title period amountMinor currency requestedById requestedByName external platform departmentId status reviewedAt reviewedByName reviewNote createdAt",
        ctx,
      );
      const departments = new Map(
        (await Department.find({ _id: { $in: docs.map((d) => d.departmentId).filter(Boolean) } }).select("name").lean())
          .map((d: any) => [String(d._id), String(d.name ?? "")]),
      );
      return {
        total,
        rows: docs.map((r): ApprovalRow => {
          const waiting = r.status === "submitted";
          return {
            id: String(r._id),
            type: "fund_request",
            title: r.title,
            subtitle: [
              departments.get(String(r.departmentId)), monthName(r.period),
              r.external?.source === "media-erp" ? "Media ERP" : "", r.platform,
            ].filter(Boolean).join(" · "),
            amountMinor: r.amountMinor,
            currency: r.currency,
            raisedBy: r.requestedByName || undefined,
            status: waiting ? "pending" : r.status,
            at: iso(r.__at),
            submittedAt: iso(r.createdAt),
            decidedAt: waiting ? undefined : iso(r.reviewedAt),
            decidedBy: waiting ? undefined : r.reviewedByName || undefined,
            reason: r.status === "rejected" ? r.reviewNote || undefined : undefined,
            // Waiting ones are decided on the Approvals page; decided ones live on Budgets.
            href: waiting ? "/approvals" : "/budgets",
            decideHere: waiting || undefined,
            own: waiting && r.requestedById && String(r.requestedById) === ctx.me ? true : undefined,
          };
        }),
      };
    },
  },
  {
    type: "tetra_deposit",
    label: "Tetra Commission deposits",
    allowed: (can) => can("tetra_deposit:approve"),
    list: async (ctx) => {
      const states = statesFor(ctx.status, { pending: ["pending"], approved: ["approved"], rejected: ["rejected"], other: ["closed"] });
      const { docs, total } = await newest(
        TetraDepositModel,
        { organizationId: ctx.org, status: { $in: states } },
        { $cond: [{ $eq: ["$status", "pending"] }, firstOf("$requestedAt", "$createdAt"), firstOf("$decision.decidedAt", "$updatedAt")] },
        "student amountMinor currency paymentMethod requestedBy initiatingMentor team requestedAt createdAt status decision delivery closedReason",
        ctx,
      );
      return {
        total,
        rows: docs.map((r): ApprovalRow => {
          const waiting = r.status === "pending";
          const undelivered = !waiting && r.status !== "closed" && r.delivery?.state && r.delivery.state !== "delivered";
          return {
            id: String(r._id),
            type: "tetra_deposit",
            title: r.student?.name ?? "Deposit",
            subtitle: [r.student?.code, r.paymentMethod, r.team].filter(Boolean).join(" · "),
            amountMinor: r.decision?.approvedAmountMinor ?? r.amountMinor,
            currency: r.currency ?? "USD",
            raisedBy: r.requestedBy || r.initiatingMentor || undefined,
            status: r.status,
            at: iso(r.__at),
            submittedAt: iso(r.requestedAt ?? r.createdAt),
            decidedAt: waiting ? undefined : iso(r.decision?.decidedAt),
            decidedBy: waiting ? undefined : r.decision?.decidedByName || undefined,
            reason: r.status === "rejected" ? r.decision?.reason || undefined : r.status === "closed" ? r.closedReason || undefined : undefined,
            href: waiting ? "/approvals" : "/tetra-deposits",
            decideHere: waiting || undefined,
            delivery: undelivered ? { state: r.delivery.state, error: r.delivery.lastError || undefined } : undefined,
          };
        }),
      };
    },
  },
  {
    type: "expense",
    label: "Expense claims",
    allowed: (can) => can("expense:approve") && (can("expense:read") || can("expense:read:own")),
    list: async (ctx) => {
      const states = statesFor(ctx.status, { pending: ["submitted"], approved: ["approved"], rejected: ["rejected"] });
      const { docs, total } = await newest(
        Expense,
        // A purchase request's expense is listed as the purchase request.
        { organizationId: ctx.org, status: { $in: states }, "source.kind": { $ne: "hrms_procurement" } },
        { $cond: [{ $eq: ["$status", "submitted"] }, "$updatedAt", firstOf("$approvedAt", "$updatedAt")] },
        "expenseNumber category categoryName description submittedByName totalMinor currency status approvedByName approvedAt rejectedReason updatedAt createdAt",
        ctx,
      );
      return {
        total,
        rows: docs.map((r): ApprovalRow => {
          const waiting = r.status === "submitted";
          return {
            id: String(r._id),
            type: "expense",
            title: r.description || r.categoryName || r.category,
            subtitle: [r.expenseNumber, r.categoryName || r.category].filter(Boolean).join(" · "),
            amountMinor: r.totalMinor ?? 0,
            currency: r.currency ?? "AED",
            raisedBy: r.submittedByName || undefined,
            status: waiting ? "pending" : r.status,
            at: iso(r.__at),
            submittedAt: waiting ? iso(r.updatedAt) : undefined,
            decidedAt: waiting ? undefined : iso(r.approvedAt),
            decidedBy: waiting ? undefined : r.approvedByName || undefined,
            reason: r.status === "rejected" ? r.rejectedReason || undefined : undefined,
            href: `/expenses/${r._id}`,
          };
        }),
      };
    },
  },
  {
    type: "bill",
    label: "Bills",
    allowed: (can) => can("bill:approve"),
    list: async (ctx) => {
      // Waiting is the state its approve route accepts, as the summary counts
      // it; decided is what the decision recorded.
      const which: Record<string, unknown>[] = [];
      if (ctx.status === "pending" || ctx.status === "all") which.push({ status: "pending_approval" });
      if (ctx.status === "approved" || ctx.status === "all") which.push({ approvalStatus: "approved", status: { $ne: "pending_approval" } });
      if (ctx.status === "rejected" || ctx.status === "all") which.push({ approvalStatus: "rejected", status: { $ne: "pending_approval" } });
      // A bill's decision keeps no time or name of its own: its last change is
      // the nearest there is.
      const { docs, total } = await newest(
        Bill,
        { organizationId: ctx.org, $or: which },
        "$updatedAt",
        "billNumber vendorName totalMinor currency dueDate status approvalStatus updatedAt createdAt",
        ctx,
      );
      return {
        total,
        rows: docs.map((r): ApprovalRow => ({
          id: String(r._id),
          type: "bill",
          title: r.vendorName,
          subtitle: [r.billNumber, r.dueDate ? `due ${new Date(r.dueDate).toISOString().slice(0, 10)}` : ""].filter(Boolean).join(" · "),
          amountMinor: r.totalMinor ?? 0,
          currency: r.currency ?? "AED",
          status: r.status === "pending_approval" ? "pending" : r.approvalStatus,
          at: iso(r.__at),
          href: `/bills/${r._id}`,
        })),
      };
    },
  },
  {
    type: "payroll",
    label: "Payroll runs",
    allowed: (can) => can("payroll:approve"),
    list: async (ctx) => {
      const states = statesFor(ctx.status, {
        pending: ["imported", "additions"],
        approved: ["approved", "partially_paid", "paid"],
        rejected: ["returned"],
      });
      const { docs, total } = await newest(
        PayrollRun,
        { organizationId: ctx.org, status: { $in: states } },
        {
          $switch: {
            branches: [
              { case: { $in: ["$status", ["imported", "additions"]] }, then: firstOf("$importedAt", "$createdAt") },
              { case: { $eq: ["$status", "returned"] }, then: "$updatedAt" },
            ],
            default: firstOf("$approvedAt", "$updatedAt"),
          },
        },
        "runNumber period hrmsOrgName payableMinor hrmsNetMinor currency status importedAt importedByName approvedById approvedAt returnedReason updatedAt",
        ctx,
      );
      // A run keeps who approved it by id alone.
      const approvers = new Map(
        (await User.find({ _id: { $in: docs.map((d) => d.approvedById).filter(Boolean) } }).select("name").lean())
          .map((u: any) => [String(u._id), String(u.name ?? "")]),
      );
      return {
        total,
        rows: docs.map((r): ApprovalRow => {
          const waiting = r.status === "imported" || r.status === "additions";
          return {
            id: String(r._id),
            type: "payroll",
            title: `${r.runNumber} · ${monthName(r.period)}`,
            subtitle: r.hrmsOrgName || "HRMS",
            amountMinor: r.payableMinor || r.hrmsNetMinor || 0,
            currency: r.currency ?? "AED",
            raisedBy: r.importedByName || undefined,
            status: waiting ? "pending" : r.status === "returned" ? "rejected" : "approved",
            at: iso(r.__at),
            submittedAt: iso(r.importedAt),
            decidedAt: !waiting && r.status !== "returned" ? iso(r.approvedAt) : undefined,
            decidedBy: !waiting && r.approvedById ? approvers.get(String(r.approvedById)) || undefined : undefined,
            reason: r.status === "returned" ? r.returnedReason || undefined : undefined,
            href: `/payroll/runs/${r._id}`,
          };
        }),
      };
    },
  },
  {
    type: "procurement",
    label: "Purchase requests",
    allowed: (can) => can("expense:approve"),
    list: async (ctx) => {
      const rows: ApprovalRow[] = [];
      let total = 0;
      let unreadable = "";

      // Waiting: read live from HRMS, as the summary does — only HRMS has them.
      if (ctx.status === "pending" || ctx.status === "all") {
        const links = await PayrollOrgLink.find({ organizationId: ctx.org, isActive: true }).select("hrmsOrgId hrmsOrgName").lean();
        let failed = 0;
        const waiting: ApprovalRow[] = [];
        for (const link of links) {
          try {
            for (const r of await procurementRequests(String(link.hrmsOrgId))) {
              const at = iso(r.hrReviewedAt ?? r.createdAt);
              if (!inRange(at, ctx.range)) continue;
              waiting.push({
                id: r._id,
                type: "procurement",
                title: `${r.quantity} × ${r.item}`,
                subtitle: [r.department?.name ?? String(link.hrmsOrgName ?? "")].filter(Boolean).join(" · "),
                // HRMS keeps major units.
                amountMinor: Math.round((r.estimatedCost || 0) * 100),
                currency: r.currency || "AED",
                raisedBy: r.requestedBy?.name || undefined,
                status: "pending",
                at,
                submittedAt: at,
                href: "/procurement",
              });
            }
          } catch {
            failed++;
          }
        }
        if (links.length && failed === links.length) unreadable = "the ones waiting in HRMS could not be read";
        waiting.sort((a, b) => String(b.at).localeCompare(String(a.at)));
        total += waiting.length;
        rows.push(...waiting.slice(0, ctx.limit));
      }

      // Approved: each became an expense here, which keeps the decision. A
      // rejected one is only kept in HRMS, so it is not listed.
      if (ctx.status === "approved" || ctx.status === "all") {
        const { docs, total: approved } = await newest(
          Expense,
          { organizationId: ctx.org, "source.kind": "hrms_procurement", status: "approved" },
          firstOf("$approvedAt", "$createdAt"),
          "expenseNumber description totalMinor currency approvedByName approvedAt createdAt",
          ctx,
        );
        total += approved;
        rows.push(...docs.map((r): ApprovalRow => ({
          id: String(r._id),
          type: "procurement",
          title: r.description,
          subtitle: [r.expenseNumber, "HRMS"].filter(Boolean).join(" · "),
          amountMinor: r.totalMinor ?? 0,
          currency: r.currency ?? "AED",
          status: "approved",
          at: iso(r.__at),
          decidedAt: iso(r.approvedAt),
          decidedBy: r.approvedByName || undefined,
          href: `/expenses/${r._id}`,
        })));
      }

      if (unreadable) {
        // Still answers with what finance has; says what it could not read.
        return Object.assign({ total, rows }, { unreadable });
      }
      return { total, rows };
    },
  },
];

/** An approved enrolment's student, in the LMS and on Tetra Commission, from the provisioning record. */
function lmsOf(p: any): ApprovalLms {
  switch (p.status) {
    case "sent":
      return p.studentCreated === false
        ? { state: "existing", detail: "Already had an LMS account — the course was added to it" }
        : { state: "created", detail: p.lmsCourseTitle ? `Enrolled in ${p.lmsCourseTitle}` : undefined };
    case "failed":
      return { state: "failed", detail: p.lastError || "The LMS turned it down" };
    case "unmapped":
      return { state: "unmapped", detail: "Its course is not linked to an LMS course yet" };
    default:
      return { state: "waiting", detail: p.lastError ? `Not reached yet (${p.lastError}); trying again` : undefined };
  }
}

function commissionOf(p: any): ApprovalCommission {
  const c = p.commission;
  if (!c?.state) {
    // Only Delta's own enrolments go on, and only once the LMS has the student.
    if (p.status !== "sent") return { state: "waiting", detail: "After the LMS" };
    return { state: "not_sent", detail: p.source && p.source !== "crm" ? "Not sent: Draw's students do not go to Tetra Commission" : "Not sent to Tetra Commission" };
  }
  switch (c.state) {
    case "sent":
      return c.alreadyThere
        ? { state: "existing", code: c.studentCode || undefined, detail: "Already had a Tetra Commission account" }
        : { state: "created", code: c.studentCode || undefined, detail: [c.team, c.mentorName].filter(Boolean).join(" · ") || undefined };
    case "skipped":
      return { state: "skipped", detail: c.reason || "Not a Forex course" };
    case "failed":
      return { state: "failed", detail: c.lastError || "Tetra Commission turned it down" };
    default:
      return { state: "waiting", detail: c.lastError ? `Not reached yet (${c.lastError}); trying again` : undefined };
  }
}

export async function approvalList(
  auth: AuthContext,
  q: ApprovalListQuery,
): Promise<{ rows: ApprovalRow[]; meta: { page: number; pageSize: number; total: number; pageCount: number; unavailable: string[] } }> {
  const can = (p: Permission) => auth.isSuperAdmin || hasPermission(auth.permissions, p);
  const org = new Types.ObjectId(auth.organizationId);
  const kinds = LIST_KINDS.filter((k) => k.allowed(can) && (!q.type || k.type === q.type));

  const range = q.from || q.to
    ? { ...(q.from ? { $gte: new Date(q.from) } : {}), ...(q.to ? { $lt: new Date(q.to) } : {}) }
    : null;
  const ctx: ListCtx = { org, me: auth.userId, status: q.status, range, limit: q.page * q.pageSize };

  const unavailable: string[] = [];
  const results = await Promise.all(kinds.map(async (kind) => {
    try {
      const result = await kind.list(ctx);
      const unreadable = (result as { unreadable?: string }).unreadable;
      if (unreadable) unavailable.push(`${kind.label}: ${unreadable}`);
      return result;
    } catch (err) {
      logger.warn({ err, type: kind.type }, "Approvals list: one kind could not be read");
      unavailable.push(`${kind.label}: ${(err as Error).message || "could not be read"}`);
      return { total: 0, rows: [] as ApprovalRow[] };
    }
  }));

  const total = results.reduce((n, r) => n + r.total, 0);
  const rows = results
    .flatMap((r) => r.rows)
    .sort((a, b) => String(b.at ?? "").localeCompare(String(a.at ?? "")) || b.id.localeCompare(a.id))
    .slice((q.page - 1) * q.pageSize, q.page * q.pageSize);

  // What became of each approved enrolment on this page, from its provisioning record.
  const approvedInvoices = rows.filter((r) => r.type === "invoice" && r.status === "approved");
  if (approvedInvoices.length) {
    const provisions = await LmsProvision.find({ invoiceId: { $in: approvedInvoices.map((r) => new Types.ObjectId(r.id)) } })
      .select("invoiceId status lastError studentCreated lmsCourseTitle source commission")
      .lean();
    const byInvoice = new Map(provisions.map((p: any) => [String(p.invoiceId), p]));
    for (const row of approvedInvoices) {
      const p = byInvoice.get(row.id);
      // No record: not an enrolment the LMS takes (a plain invoice, or from before).
      if (!p) continue;
      row.lms = lmsOf(p);
      row.commission = commissionOf(p);
    }
  }

  return {
    rows,
    meta: { page: q.page, pageSize: q.pageSize, total, pageCount: Math.max(1, Math.ceil(total / q.pageSize)), unavailable },
  };
}
