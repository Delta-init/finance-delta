import { Types } from "mongoose";
import { hasPermission, type ApprovalGroup, type ApprovalItem, type ApprovalSummary, type Permission } from "@delta/shared";
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
    allowed: (can) => can("po:create"),
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
