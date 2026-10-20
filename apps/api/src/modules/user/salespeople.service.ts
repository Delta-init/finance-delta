import crypto from "node:crypto";
import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { hashPassword } from "../../lib/password";
import { User } from "./user.model";
import { Role } from "../role/role.model";
import { Department } from "../department/department.model";
import { Invoice } from "../invoice/invoice.model";

/*
 * Salespeople on the Users page (the user, 2026-10-20: "the sales people show in the user area too, and we can
 * convert them into actual users").
 *
 * Two kinds:
 *   - payroll-only accounts — made from the HRMS payroll so an employee can be named as a salesperson and earn
 *     commission (payroll-mapping ensureSalespersonLogin). They hold the "payroll-employee" role, no permissions,
 *     and no password anybody knows; the team list leaves them out (listUsers excludePayrollOnly).
 *   - CRM salespeople finance has no account for at all — named on an enrolment a CRM sent
 *     (enrolment.meetingByEmail) and billed against whoever can approve instead (enrolment-intake resolveSalesperson).
 *
 * Converting gives a payroll-only account a real role here and a way in — an invite to set their own password, or
 * one an administrator sets. It is the same account, so every invoice and commission line stays theirs. Creating one
 * for a CRM salesperson can also move the invoices billed against somebody else for want of them.
 */

const PAYROLL_ROLE = "payroll-employee";
const oid = (id: string) => new Types.ObjectId(id);
const NO_ACCOUNT = /has no account here/;

async function payrollRoleId(orgId: string): Promise<Types.ObjectId | null> {
  const r = await Role.findOne({ organizationId: oid(orgId), key: PAYROLL_ROLE }).select("_id").lean();
  return r ? (r._id as Types.ObjectId) : null;
}

export interface SalespersonRow {
  id: string;
  name: string;
  email: string;
  department: { id: string; name: string } | null;
  status: "active" | "suspended";
  invoices: number;
  lastSaleAt: string | null;
  crms: string[];
}
export interface MissingSalespersonRow {
  email: string;
  name: string;
  invoices: number;
  lastSaleAt: string | null;
  crms: string[];
  /** Has an account in another organization — creating one here adds this organization to it. */
  elsewhere: boolean;
}

/** Invoices per person in this organization: how many, the latest, from which CRMs. */
async function salesBy(orgId: string, match: Record<string, unknown>, key: "$salespersonId" | { $toLower: string }) {
  return Invoice.aggregate<{ _id: unknown; n: number; last: Date | null; crms: string[]; name: string }>([
    { $match: { organizationId: oid(orgId), ...match } },
    { $group: { _id: key, n: { $sum: 1 }, last: { $max: "$issueDate" }, crms: { $addToSet: "$enrolment.crm" }, name: { $last: "$enrolment.meetingBy" } } },
  ]);
}

export async function listSalespeople(orgId: string, q = ""): Promise<{ payroll: SalespersonRow[]; missing: MissingSalespersonRow[] }> {
  const roleId = await payrollRoleId(orgId);
  const search = q.trim()
    ? { $or: [{ name: new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }, { email: new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }] }
    : {};
  const people = roleId
    ? await User.find({ memberships: { $elemMatch: { organizationId: oid(orgId), roleId } }, ...search })
        .select("name email status memberships").sort({ name: 1 }).lean()
    : [];
  const depts = new Map((await Department.find({ organizationId: oid(orgId) }).select("name").lean()).map((d) => [String(d._id), String(d.name)]));
  const sold = new Map(
    (await salesBy(orgId, { salespersonId: { $in: people.map((p) => p._id) } }, "$salespersonId")).map((r) => [String(r._id), r]),
  );
  const payroll: SalespersonRow[] = people.map((p) => {
    const m = (p.memberships ?? []).find((x) => String(x.organizationId) === orgId);
    const deptId = m?.departmentId ? String(m.departmentId) : "";
    const s = sold.get(String(p._id));
    return {
      id: String(p._id), name: String(p.name), email: String(p.email),
      department: deptId && depts.has(deptId) ? { id: deptId, name: depts.get(deptId)! } : null,
      status: p.status === "suspended" ? "suspended" : "active",
      invoices: s?.n ?? 0, lastSaleAt: s?.last ? new Date(s.last).toISOString() : null,
      crms: (s?.crms ?? []).filter(Boolean),
    };
  });

  // CRM salespeople on this organization's enrolments with no account here.
  const named = await salesBy(orgId, { "enrolment.meetingByEmail": { $exists: true, $nin: ["", null] } }, { $toLower: "$enrolment.meetingByEmail" });
  const emails = named.map((r) => String(r._id));
  const accounts = await User.find({ email: { $in: emails } }).select("email memberships").lean();
  const here = new Set(accounts.filter((a) => (a.memberships ?? []).some((m) => String(m.organizationId) === orgId)).map((a) => String(a.email)));
  const anywhere = new Set(accounts.map((a) => String(a.email)));
  const needle = q.trim().toLowerCase();
  const missing: MissingSalespersonRow[] = named
    .filter((r) => !here.has(String(r._id)))
    .map((r) => ({
      email: String(r._id), name: String(r.name ?? "").trim() || String(r._id),
      invoices: r.n, lastSaleAt: r.last ? new Date(r.last).toISOString() : null,
      crms: (r.crms ?? []).filter(Boolean), elsewhere: anywhere.has(String(r._id)),
    }))
    .filter((r) => !needle || r.email.includes(needle) || r.name.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { payroll, missing };
}

export interface ConvertInput {
  roleId: string;
  departmentId?: string | null;
  isManager?: boolean;
  /** Set by the administrator; else (or as well) an invite is sent when asked. */
  password?: string;
  sendInvite?: boolean;
}

async function requireRealRole(orgId: string, roleId: string) {
  if (!Types.ObjectId.isValid(roleId)) throw new AppError("VALIDATION_ERROR", "Choose a role");
  const role = await Role.findOne({ _id: oid(roleId), organizationId: oid(orgId) }).select("key name").lean();
  if (!role) throw new AppError("NOT_FOUND", "That role isn't one of this organization's");
  if (role.key === PAYROLL_ROLE) throw new AppError("VALIDATION_ERROR", "Pick a role that can sign in — not Payroll employee");
  return role;
}
async function requireDept(orgId: string, departmentId?: string | null) {
  if (!departmentId) return null;
  if (!Types.ObjectId.isValid(departmentId)) throw new AppError("VALIDATION_ERROR", "Unknown department");
  const d = await Department.findOne({ _id: oid(departmentId), organizationId: oid(orgId) }).select("_id").lean();
  if (!d) throw new AppError("NOT_FOUND", "That department isn't one of this organization's");
  return d._id as Types.ObjectId;
}

/** A payroll-only account given a real role here, and a password or an invite. */
export async function convertSalesperson(orgId: string, userId: string, input: ConvertInput): Promise<{ id: string; name: string; email: string }> {
  if (!Types.ObjectId.isValid(userId)) throw new AppError("NOT_FOUND", "User not found");
  const roleId = await payrollRoleId(orgId);
  const user = await User.findOne({ _id: oid(userId), "memberships.organizationId": oid(orgId) });
  if (!user) throw new AppError("NOT_FOUND", "User not found");
  const m = user.memberships.find((x) => x.organizationId.equals(orgId))!;
  if (!roleId || !m.roleId.equals(roleId)) throw new AppError("CONFLICT", `${user.name} can already sign in here — edit them from the team list`);
  const role = await requireRealRole(orgId, input.roleId);
  const dept = input.departmentId !== undefined ? await requireDept(orgId, input.departmentId) : m.departmentId ?? null;
  m.roleId = role._id as Types.ObjectId;
  m.departmentId = dept ?? undefined;
  m.status = "active";
  if (input.isManager !== undefined) m.isManager = input.isManager;
  if (input.password) user.passwordHash = await hashPassword(input.password);
  user.status = "active";
  await user.save();
  return { id: String(user._id), name: user.name, email: user.email };
}

export interface CreateFromCrmInput extends ConvertInput {
  email: string;
  name: string;
  /** Move the invoices billed against somebody else for want of this person to them. */
  moveInvoices?: boolean;
}

/** An account for a CRM salesperson finance had none for — and, asked, their invoices moved to them. */
export async function createFromCrm(orgId: string, input: CreateFromCrmInput): Promise<{ id: string; name: string; email: string; moved: number }> {
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new AppError("VALIDATION_ERROR", "A valid email is required");
  const name = String(input.name ?? "").trim();
  if (name.length < 2) throw new AppError("VALIDATION_ERROR", "A name is required");
  const role = await requireRealRole(orgId, input.roleId);
  const dept = await requireDept(orgId, input.departmentId);
  const membership = { organizationId: oid(orgId), roleId: role._id as Types.ObjectId, departmentId: dept ?? undefined, status: "active" as const, isManager: input.isManager ?? false };

  let user = await User.findOne({ email });
  if (user) {
    if (user.memberships.some((x) => x.organizationId.equals(orgId))) throw new AppError("CONFLICT", `${email} already has an account here`);
    user.memberships.push(membership);
    if (input.password) user.passwordHash = await hashPassword(input.password);
    await user.save();
  } else {
    user = await User.create({
      name, email, status: "active", memberships: [membership],
      // Nobody knows this one: the way in is the invite, or the password the administrator set.
      passwordHash: await hashPassword(input.password || `${crypto.randomUUID()}${crypto.randomUUID()}`),
    });
  }

  let moved = 0;
  if (input.moveInvoices) {
    const r = await Invoice.updateMany(
      { organizationId: oid(orgId), "enrolment.meetingByEmail": email, salespersonId: { $ne: user._id } },
      { $set: { salespersonId: user._id, salespersonName: user.name }, $pull: { "external.flags": NO_ACCOUNT } },
    );
    moved = r.modifiedCount;
  }
  return { id: String(user._id), name: user.name, email: user.email, moved };
}
