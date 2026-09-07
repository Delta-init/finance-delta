import { Types } from "mongoose";
import type {
  CreateUserInput,
  Paginated,
  UpdateUserInput,
  User as UserDTO,
  UserQuery,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { hashPassword } from "../../lib/password";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { User } from "./user.model";
import { Role } from "../role/role.model";
import { Department } from "../department/department.model";

interface PopulatedRole {
  _id: Types.ObjectId;
  key: string;
  name: string;
}

type DepartmentRef = { id: string; name: string } | null;

type UserDoc = {
  _id: Types.ObjectId;
  name: string;
  email: string;
  status: string;
  createdAt: Date;
  isSuperAdmin?: boolean;
};

function toDTO(
  doc: UserDoc,
  role: PopulatedRole,
  department: DepartmentRef = null,
): UserDTO {
  return {
    id: doc._id.toString(),
    name: doc.name,
    email: doc.email,
    status: doc.status as "active" | "suspended",
    role: { id: role._id.toString(), key: role.key, name: role.name },
    isSuperAdmin: doc.isSuperAdmin ?? false,
    department,
    tags: [],
    createdAt: doc.createdAt.toISOString(),
  };
}

async function requireOrgDepartment(orgId: string, departmentId: string) {
  const dept = await Department.findOne({ _id: departmentId, organizationId: orgId });
  if (!dept) throw new AppError("VALIDATION_ERROR", "Invalid department selected");
  return dept;
}

async function departmentMap(orgId: string): Promise<Map<string, string>> {
  const rows = await Department.find({ organizationId: orgId }).select("name");
  return new Map(rows.map((d) => [d._id.toString(), d.name]));
}

const SORT = {
  name: "name",
  email: "email",
  status: "status",
  createdAt: "createdAt",
} as const;

export async function listUsers(orgId: string, query: UserQuery): Promise<Paginated<UserDTO>> {
  const filter: Record<string, unknown> = {
    "memberships.organizationId": new Types.ObjectId(orgId),
  };
  const or = searchOr(query.q, ["name", "email"]);
  if (or) filter.$or = or;
  if (query.status) filter.status = query.status;

  // Accounts minted so a payroll employee can be named as a salesperson. They
  // hold no permissions and cannot be signed into, so listing them among the
  // staff buries the real users under a roster — a hundred and fifty of them on
  // a normal payroll. They are still returned to the salesperson pickers, which
  // is the only reason they exist.
  if (query.excludePayrollOnly) {
    const payrollRole = await Role.findOne({
      organizationId: new Types.ObjectId(orgId),
      key: "payroll-employee",
    })
      .select("_id")
      .lean();
    if (payrollRole) {
      filter.memberships = {
        $elemMatch: {
          organizationId: new Types.ObjectId(orgId),
          roleId: { $ne: payrollRole._id },
        },
      };
    }
  }

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    User.find(filter)
      .sort(sort)
      .skip(skipFor(query.page, query.pageSize))
      .limit(query.pageSize),
    User.countDocuments(filter),
  ]);

  const deptNames = await departmentMap(orgId);
  const results: UserDTO[] = [];
  for (const u of rows) {
    const membership = u.memberships.find((m) => m.organizationId.equals(orgId));
    if (!membership) continue;
    const role = await Role.findById(membership.roleId).select("key name");
    if (!role) continue;
    const deptId = membership.departmentId?.toString();
    const department = deptId && deptNames.has(deptId) ? { id: deptId, name: deptNames.get(deptId)! } : null;
    results.push(toDTO(u as unknown as UserDoc, role as unknown as PopulatedRole, department));
  }

  return { data: results, meta: pageMeta(total, query.page, query.pageSize) };
}

async function requireOrgRole(orgId: string, roleId: string) {
  const role = await Role.findOne({ _id: roleId, organizationId: orgId });
  if (!role) throw new AppError("VALIDATION_ERROR", "Invalid role selected");
  return role;
}

/** Who is asking. Super admin is granted from above, never from within. */
export interface Actor {
  userId: string;
  isSuperAdmin: boolean;
}

/**
 * Only a super admin may hand out super admin.
 *
 * An organization administrator holds the wildcard permission, so without this
 * every administrator could mint themselves an account that reads and writes
 * every *other* organization on the platform. The permission system cannot
 * express that, because the wildcard is scoped to an organization and this flag
 * is not — so it is checked here, on the one field that grants it.
 */
function assertMaySetSuperAdmin(actor: Actor) {
  if (!actor.isSuperAdmin) {
    throw new AppError("FORBIDDEN", "Only a super admin can grant super admin access");
  }
}

/**
 * What an update should do to somebody's super admin flag: `null` for "leave it
 * alone", a boolean to write.
 *
 * Asking for the value it already holds is not a change, so an ordinary
 * administrator editing a super admin's name or department is not refused for
 * echoing back a field they may not set.
 */
export function superAdminChange(
  current: boolean,
  requested: boolean | undefined,
  actor: Actor,
  targetUserId: string,
): boolean | null {
  if (requested === undefined || requested === current) return null;
  assertMaySetSuperAdmin(actor);
  // Taking it off yourself is how a platform ends up with nobody who can put
  // it back. Another super admin can do it; you cannot do it to yourself.
  if (!requested && targetUserId === actor.userId) {
    throw new AppError("CONFLICT", "You cannot remove your own super admin access");
  }
  return requested;
}

export async function createUser(
  orgId: string,
  input: CreateUserInput,
  actor: Actor,
): Promise<UserDTO> {
  if (input.isSuperAdmin) assertMaySetSuperAdmin(actor);
  const role = await requireOrgRole(orgId, input.roleId);
  const dept = input.departmentId ? await requireOrgDepartment(orgId, input.departmentId) : null;
  const departmentRef = dept ? { id: dept._id.toString(), name: dept.name } : null;

  // If the user already exists (globally), just add a membership.
  const existing = await User.findOne({ email: input.email.toLowerCase() });
  if (existing) {
    const alreadyMember = existing.memberships.some((m) => m.organizationId.equals(orgId));
    if (alreadyMember) throw new AppError("CONFLICT", "User is already a member of this organization");

    existing.memberships.push({
      organizationId: new Types.ObjectId(orgId),
      roleId: role._id,
      departmentId: dept?._id,
      status: "active",
    });
    if (input.isSuperAdmin) existing.isSuperAdmin = true;
    await existing.save();
    return toDTO(existing as unknown as UserDoc, role as unknown as PopulatedRole, departmentRef);
  }

  const user = await User.create({
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    isSuperAdmin: input.isSuperAdmin ?? false,
    status: "active",
    memberships: [{ organizationId: new Types.ObjectId(orgId), roleId: role._id, departmentId: dept?._id, status: "active" }],
  });

  return toDTO(user as unknown as UserDoc, role as unknown as PopulatedRole, departmentRef);
}

export async function updateUser(
  orgId: string,
  userId: string,
  input: UpdateUserInput,
  actor: Actor,
): Promise<UserDTO> {
  const user = await User.findOne({
    _id: userId,
    "memberships.organizationId": new Types.ObjectId(orgId),
  });
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  if (input.name !== undefined) user.name = input.name;
  if (input.status !== undefined) user.status = input.status;

  const superAdmin = superAdminChange(user.isSuperAdmin ?? false, input.isSuperAdmin, actor, userId);
  if (superAdmin !== null) user.isSuperAdmin = superAdmin;

  const membership = user.memberships.find((m) => m.organizationId.equals(orgId));
  if (membership && input.roleId !== undefined) {
    const role = await requireOrgRole(orgId, input.roleId);
    membership.roleId = role._id;
  }
  if (membership && input.departmentId !== undefined) {
    if (input.departmentId) {
      const dept = await requireOrgDepartment(orgId, input.departmentId);
      membership.departmentId = dept._id;
    } else {
      membership.departmentId = undefined;
    }
  }

  await user.save();

  const finalRole = await Role.findById(membership?.roleId).select("key name");
  if (!finalRole) throw new AppError("INTERNAL", "Role not found");

  let department: DepartmentRef = null;
  if (membership?.departmentId) {
    const dept = await Department.findById(membership.departmentId).select("name");
    if (dept) department = { id: dept._id.toString(), name: dept.name };
  }

  return toDTO(user as unknown as UserDoc, finalRole as unknown as PopulatedRole, department);
}

/**
 * Take somebody out of this organization.
 *
 * Refused while their name is on anything. An invoice records who sold it and
 * an expense who claimed it, and removing the person those point at leaves a
 * document that cannot say who was responsible for it — which is exactly what
 * somebody looks for when they go back through a year's records. Suspending is
 * the answer there: the access goes, the history stays.
 *
 * A person belonging to more than one organization keeps their account and
 * loses this membership. Nobody in one organization should be able to delete
 * somebody out of another.
 */
export async function removeUser(orgId: string, userId: string, actingUserId: string): Promise<void> {
  if (userId === actingUserId) {
    throw new AppError("CONFLICT", "You cannot remove yourself");
  }

  const oid = new Types.ObjectId(orgId);
  const user = await User.findOne({ _id: userId, "memberships.organizationId": oid });
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  const uid = new Types.ObjectId(userId);
  const { Invoice } = await import("../invoice/invoice.model");
  const { Expense } = await import("../expense/expense.model");

  const [invoices, expenses] = await Promise.all([
    Invoice.countDocuments({ organizationId: oid, salespersonId: uid }),
    Expense.countDocuments({ organizationId: oid, submittedById: uid }),
  ]);

  if (invoices > 0 || expenses > 0) {
    const parts = [
      invoices > 0 ? `${invoices} invoice${invoices === 1 ? "" : "s"}` : "",
      expenses > 0 ? `${expenses} expense claim${expenses === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    throw new AppError(
      "CONFLICT",
      `${user.name} is named on ${parts.join(" and ")}, so removing them would leave those records with nobody against them. Suspend them instead — they lose access and the history stays.`,
    );
  }

  user.memberships = user.memberships.filter((m) => !m.organizationId.equals(oid)) as typeof user.memberships;

  // Their account goes only when it belongs nowhere else.
  if (user.memberships.length === 0) await user.deleteOne();
  else await user.save();
}

/**
 * Just the names of the people in this organization.
 *
 * A counsellor naming the colleague who ran the meeting needs a list to pick
 * from, and holds none of the permissions that read the user list — reasonably,
 * since that list carries email addresses, roles and status.
 *
 * This carries a name and an id and nothing else. Those are already on every
 * invoice a counsellor can see, in `salespersonName` and on the approval, so
 * there is nothing here they could not already read.
 */
export async function listColleagues(orgId: string): Promise<{ id: string; name: string }[]> {
  const users = await User.find({
    status: "active",
    memberships: {
      $elemMatch: { organizationId: new Types.ObjectId(orgId), status: "active" },
    },
  })
    .select("name")
    .sort({ name: 1 })
    .lean();

  return users.map((u) => ({ id: String(u._id), name: u.name as string }));
}
