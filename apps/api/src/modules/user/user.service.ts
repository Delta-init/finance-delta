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

function toDTO(
  doc: { _id: Types.ObjectId; name: string; email: string; status: string; createdAt: Date },
  role: PopulatedRole,
  department: DepartmentRef = null,
): UserDTO {
  return {
    id: doc._id.toString(),
    name: doc.name,
    email: doc.email,
    status: doc.status as "active" | "suspended",
    role: { id: role._id.toString(), key: role.key, name: role.name },
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
    results.push(toDTO(u as unknown as { _id: Types.ObjectId; name: string; email: string; status: string; createdAt: Date }, role as unknown as PopulatedRole, department));
  }

  return { data: results, meta: pageMeta(total, query.page, query.pageSize) };
}

async function requireOrgRole(orgId: string, roleId: string) {
  const role = await Role.findOne({ _id: roleId, organizationId: orgId });
  if (!role) throw new AppError("VALIDATION_ERROR", "Invalid role selected");
  return role;
}

export async function createUser(orgId: string, input: CreateUserInput): Promise<UserDTO> {
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
    await existing.save();
    return toDTO(existing as unknown as { _id: Types.ObjectId; name: string; email: string; status: string; createdAt: Date }, role as unknown as PopulatedRole, departmentRef);
  }

  const user = await User.create({
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    isSuperAdmin: false,
    status: "active",
    memberships: [{ organizationId: new Types.ObjectId(orgId), roleId: role._id, departmentId: dept?._id, status: "active" }],
  });

  return toDTO(user as unknown as { _id: Types.ObjectId; name: string; email: string; status: string; createdAt: Date }, role as unknown as PopulatedRole, departmentRef);
}

export async function updateUser(
  orgId: string,
  userId: string,
  input: UpdateUserInput,
): Promise<UserDTO> {
  const user = await User.findOne({
    _id: userId,
    "memberships.organizationId": new Types.ObjectId(orgId),
  });
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  if (input.name !== undefined) user.name = input.name;
  if (input.status !== undefined) user.status = input.status;

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

  return toDTO(user as unknown as { _id: Types.ObjectId; name: string; email: string; status: string; createdAt: Date }, finalRole as unknown as PopulatedRole, department);
}
