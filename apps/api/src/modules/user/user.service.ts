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
import { resolveTagIds, toTagRefs } from "../../lib/tags";
import { User } from "./user.model";
import { Role } from "../role/role.model";

interface PopulatedRole {
  _id: Types.ObjectId;
  key: string;
  name: string;
}

interface UserLike {
  _id: Types.ObjectId;
  name: string;
  email: string;
  status: string;
  tagIds?: unknown;
  createdAt: Date;
}

function toDTO(doc: UserLike, role: PopulatedRole): UserDTO {
  return {
    id: doc._id.toString(),
    name: doc.name,
    email: doc.email,
    status: doc.status as "active" | "suspended",
    role: { id: role._id.toString(), key: role.key, name: role.name },
    tags: toTagRefs(doc.tagIds),
    createdAt: doc.createdAt.toISOString(),
  };
}

const SORT = {
  name: "name",
  email: "email",
  status: "status",
  createdAt: "createdAt",
} as const;

export async function listUsers(orgId: string, query: UserQuery): Promise<Paginated<UserDTO>> {
  const filter: Record<string, unknown> = { organizationId: orgId };
  const or = searchOr(query.q, ["name", "email"]);
  if (or) filter.$or = or;
  if (query.status) filter.status = query.status;
  if (query.tagIds?.length) filter.tagIds = { $in: query.tagIds };

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    User.find(filter)
      .populate<{ roleId: PopulatedRole }>("roleId", "key name")
      .populate("tagIds", "name color")
      .sort(sort)
      .skip(skipFor(query.page, query.pageSize))
      .limit(query.pageSize),
    User.countDocuments(filter),
  ]);

  return {
    data: rows.map((u) =>
      toDTO(u as unknown as UserLike, u.roleId as unknown as PopulatedRole),
    ),
    meta: pageMeta(total, query.page, query.pageSize),
  };
}

async function requireOrgRole(orgId: string, roleId: string) {
  const role = await Role.findOne({ _id: roleId, organizationId: orgId });
  if (!role) throw new AppError("VALIDATION_ERROR", "Invalid role selected");
  return role;
}

export async function createUser(orgId: string, input: CreateUserInput): Promise<UserDTO> {
  const role = await requireOrgRole(orgId, input.roleId);
  const exists = await User.exists({ organizationId: orgId, email: input.email });
  if (exists) throw new AppError("CONFLICT", "A user with this email already exists");

  const tagIds = await resolveTagIds(orgId, input.tagIds);
  const user = await User.create({
    organizationId: new Types.ObjectId(orgId),
    name: input.name,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    roleId: role._id,
    status: "active",
    tagIds,
  });
  await user.populate("tagIds", "name color");
  return toDTO(user as unknown as UserLike, role as unknown as PopulatedRole);
}

export async function updateUser(
  orgId: string,
  userId: string,
  input: UpdateUserInput,
): Promise<UserDTO> {
  const user = await User.findOne({ _id: userId, organizationId: orgId });
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  if (input.name !== undefined) user.name = input.name;
  if (input.status !== undefined) user.status = input.status;
  if (input.roleId !== undefined) {
    const role = await requireOrgRole(orgId, input.roleId);
    user.roleId = role._id;
  }
  if (input.tagIds !== undefined) {
    user.set("tagIds", await resolveTagIds(orgId, input.tagIds));
  }
  await user.save();
  await user.populate("tagIds", "name color");

  const role = await Role.findById(user.roleId).select("key name");
  return toDTO(user as unknown as UserLike, role as unknown as PopulatedRole);
}
