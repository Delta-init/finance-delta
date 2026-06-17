import { Types } from "mongoose";
import type {
  CreateRoleInput,
  Paginated,
  Role as RoleDTO,
  RoleQuery,
  UpdateRoleInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { Role, type RoleDoc } from "./role.model";
import { User } from "../user/user.model";

function toDTO(doc: RoleDoc): RoleDTO {
  return {
    id: doc._id.toString(),
    key: doc.key,
    name: doc.name,
    description: doc.description ?? "",
    permissions: doc.permissions ?? [],
    isSystem: doc.isSystem ?? false,
  };
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SORT = { name: "name", createdAt: "createdAt" } as const;

export async function listRoles(
  orgId: string,
  query: RoleQuery,
): Promise<Paginated<RoleDTO>> {
  const filter: Record<string, unknown> = { organizationId: orgId };
  const or = searchOr(query.q, ["name", "description"]);
  if (or) filter.$or = or;

  const sort = buildSort(SORT, query.sort, query.dir, { isSystem: -1, name: 1 });
  const [rows, total] = await Promise.all([
    Role.find(filter).sort(sort).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize),
    Role.countDocuments(filter),
  ]);
  return { data: rows.map(toDTO), meta: pageMeta(total, query.page, query.pageSize) };
}

export async function createRole(
  orgId: string,
  input: CreateRoleInput,
): Promise<RoleDTO> {
  const base = slugify(input.name) || "role";
  // Ensure a unique key within the org.
  let key = base;
  let i = 1;
  while (await Role.exists({ organizationId: orgId, key })) {
    key = `${base}-${i++}`;
  }

  const role = await Role.create({
    organizationId: new Types.ObjectId(orgId),
    key,
    name: input.name,
    description: input.description ?? "",
    permissions: input.permissions,
    isSystem: false,
  });
  return toDTO(role);
}

export async function updateRole(
  orgId: string,
  roleId: string,
  input: UpdateRoleInput,
): Promise<RoleDTO> {
  const role = await Role.findOne({ _id: roleId, organizationId: orgId });
  if (!role) throw new AppError("NOT_FOUND", "Role not found");
  if (role.isSystem && role.key === "admin") {
    throw new AppError("CONFLICT", "The Administrator role cannot be modified");
  }
  if (input.name !== undefined) role.name = input.name;
  if (input.description !== undefined) role.description = input.description;
  if (input.permissions !== undefined) role.permissions = input.permissions;
  await role.save();
  return toDTO(role);
}

export async function deleteRole(orgId: string, roleId: string): Promise<void> {
  const role = await Role.findOne({ _id: roleId, organizationId: orgId });
  if (!role) throw new AppError("NOT_FOUND", "Role not found");
  if (role.isSystem) {
    throw new AppError("CONFLICT", "System roles cannot be deleted");
  }
  const inUse = await User.exists({ organizationId: orgId, roleId });
  if (inUse) {
    throw new AppError(
      "CONFLICT",
      "Role is assigned to one or more users; reassign them first",
    );
  }
  await role.deleteOne();
}
