import { Types } from "mongoose";
import type { ApprovalGroup } from "@delta/shared";
import { AppError } from "../../lib/http";
import { logger } from "../../lib/logger";
import { approvalSummary, decidesApproval } from "../approvals/approvals.service";
import { Organization } from "../organization/organization.model";
import { Role } from "../role/role.model";
import { User } from "../user/user.model";

/**
 * What is waiting in finance, for the Root portal's Pending page: the counts
 * the sidebar's badges show, and who each one is waiting on.
 *
 * The sidebar counts per organization; this is every organization added up.
 * Each count is the one a super admin's sidebar shows (approvalSummary, read
 * as a super admin), so nothing is counted twice and nothing is copied.
 *
 * Every finance approval waits on anybody who may decide it rather than on one
 * named person, so each kind is `shared`: everybody active who may decide it
 * in an organization — by their role there, or as a super admin, who may
 * decide anything anywhere — is given that organization's whole count (the
 * user, 2026-10-11).
 *
 * Purchase requests are left out: they are read live from HRMS, and the Root
 * portal asks HRMS itself.
 */

type KindType = ApprovalGroup["type"];

/**
 * The sidebar's badges, in its order, named as it names them. The Approvals
 * entry's badge is all of these added up, so it is not a kind of its own;
 * enrolment invoices have no entry but that one, so they come first, under the
 * name the Approvals page gives them.
 */
const KINDS: Array<{ type: KindType; key: string; label: string }> = [
  { type: "invoice", key: "enrolment_invoices", label: "Enrolment invoices" },
  { type: "bill", key: "bills", label: "Bills" },
  { type: "expense", key: "expense_claims", label: "Expenses" },
  { type: "fund_request", key: "fund_requests", label: "Budgets & Funds" },
  { type: "tetra_deposit", key: "tetra_deposits", label: "Tetra Deposits" },
  { type: "payroll", key: "payroll_runs", label: "Payroll" },
];
const LEFT_OUT: KindType[] = ["procurement"];

export interface PortalPendingKind {
  key: string;
  label: string;
  total: number;
  shared: true;
}

export interface PortalPendingPerson {
  id: string;
  name: string;
  email: string;
  active: boolean;
  counts: Record<string, number>;
  total: number;
}

export async function pendingForPortal(): Promise<{ kinds: PortalPendingKind[]; people: PortalPendingPerson[] }> {
  const orgs = await Organization.find().select("_id").lean();

  // Read as a super admin whose id matches nobody: a fund request is never
  // left out as the reader's own, so every one waiting is counted.
  const nobody = new Types.ObjectId().toString();
  const perOrg = new Map<string, Map<KindType, number>>();
  await Promise.all(orgs.map(async (o) => {
    const summary = await approvalSummary(
      { userId: nobody, organizationId: String(o._id), role: "", permissions: [], isSuperAdmin: true },
      { without: LEFT_OUT },
    );
    // A kind it could not read is not "nothing waiting": say so rather than
    // hand the Root portal a 0.
    const unreadable = summary.groups.filter((g) => g.unavailable);
    if (unreadable.length) {
      logger.warn({ org: String(o._id), kinds: unreadable.map((g) => g.type) }, "Root pending: a kind could not be read");
      throw new AppError("UNAVAILABLE", `Could not read ${unreadable.map((g) => g.label).join(", ")}`);
    }
    perOrg.set(String(o._id), new Map(summary.groups.map((g) => [g.type, g.count])));
  }));

  const countIn = (org: string, type: KindType) => perOrg.get(org)?.get(type) ?? 0;
  const kinds: PortalPendingKind[] = KINDS.map((k) => ({
    key: k.key,
    label: k.label,
    total: [...perOrg.keys()].reduce((n, org) => n + countIn(org, k.type), 0),
    shared: true,
  }));

  // Active staff only: a suspended account, or an invited or suspended
  // membership, decides nothing.
  const users = await User.find({ status: { $ne: "suspended" } }).select("name email isSuperAdmin memberships").lean();
  const roleIds = [...new Set(users.flatMap((u) => (u.memberships ?? []).map((m) => String(m.roleId))))];
  const roles = new Map(
    (await Role.find({ _id: { $in: roleIds.map((id) => new Types.ObjectId(id)) } }).select("permissions").lean())
      .map((r) => [String(r._id), r.permissions ?? []]),
  );

  const people: PortalPendingPerson[] = [];
  for (const u of users) {
    const counts: Record<string, number> = {};
    // Where they may decide, and with what: every organization for a super
    // admin, otherwise each organization they are an active member of, by
    // their role there.
    const where: Array<{ org: string; permissions: string[] }> = u.isSuperAdmin
      ? [...perOrg.keys()].map((org) => ({ org, permissions: [] }))
      : (u.memberships ?? [])
        .filter((m) => (m.status ?? "active") === "active" && perOrg.has(String(m.organizationId)))
        .map((m) => ({ org: String(m.organizationId), permissions: roles.get(String(m.roleId)) ?? [] }));
    for (const { org, permissions } of where) {
      for (const k of KINDS) {
        const n = countIn(org, k.type);
        if (n && decidesApproval(k.type, permissions, Boolean(u.isSuperAdmin))) counts[k.key] = (counts[k.key] ?? 0) + n;
      }
    }
    const total = Object.entries(counts).reduce((n, [key, c]) => (key.endsWith("_overdue") ? n : n + c), 0);
    if (!total) continue;
    people.push({ id: String(u._id), name: u.name, email: String(u.email).toLowerCase(), active: true, counts, total });
  }
  people.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  return { kinds, people };
}
