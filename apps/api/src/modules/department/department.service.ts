import { Types } from "mongoose";
import type {
  CreateDepartmentInput,
  Department as DepartmentDTO,
  DepartmentQuery,
  Paginated,
  UpdateDepartmentInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { User } from "../user/user.model";
import { Customer } from "../customer/customer.model";
import { Item } from "../inventory/item.model";
import { Department, type DepartmentDoc } from "./department.model";

function toDTO(doc: DepartmentDoc): DepartmentDTO {
  return {
    id: doc._id.toString(),
    name: doc.name,
    description: doc.description ?? "",
    createdAt: doc.createdAt.toISOString(),
  };
}

const SORT = { name: "name", createdAt: "createdAt" } as const;

export async function listDepartments(
  orgId: string,
  query: DepartmentQuery,
): Promise<Paginated<DepartmentDTO>> {
  const filter: Record<string, unknown> = { organizationId: orgId };
  const or = searchOr(query.q, ["name", "description"]);
  if (or) filter.$or = or;

  const sort = buildSort(SORT, query.sort, query.dir, { name: 1 });
  const [rows, total] = await Promise.all([
    Department.find(filter).sort(sort).skip(skipFor(query.page, query.pageSize)).limit(query.pageSize),
    Department.countDocuments(filter),
  ]);
  return { data: rows.map(toDTO), meta: pageMeta(total, query.page, query.pageSize) };
}

/** All departments (unpaginated) — for pickers and filters. */
export async function listAllDepartments(orgId: string): Promise<DepartmentDTO[]> {
  const rows = await Department.find({ organizationId: orgId }).sort({ name: 1 });
  return rows.map(toDTO);
}

export async function createDepartment(
  orgId: string,
  input: CreateDepartmentInput,
): Promise<DepartmentDTO> {
  const exists = await Department.exists({ organizationId: orgId, name: input.name });
  if (exists) throw new AppError("CONFLICT", "A department with this name already exists");
  const doc = await Department.create({
    organizationId: new Types.ObjectId(orgId),
    name: input.name,
    description: input.description ?? "",
  });
  return toDTO(doc);
}

export async function updateDepartment(
  orgId: string,
  id: string,
  input: UpdateDepartmentInput,
): Promise<DepartmentDTO> {
  const doc = await Department.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Department not found");
  if (input.name !== undefined && input.name !== doc.name) {
    const exists = await Department.exists({ organizationId: orgId, name: input.name, _id: { $ne: doc._id } });
    if (exists) throw new AppError("CONFLICT", "A department with this name already exists");
    doc.name = input.name;
  }
  if (input.description !== undefined) doc.description = input.description;
  await doc.save();
  return toDTO(doc);
}

export async function deleteDepartment(orgId: string, id: string): Promise<void> {
  const doc = await Department.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Department not found");
  // Clear references so users/customers simply lose the assignment.
  const orgObjId = new Types.ObjectId(orgId);
  await Promise.all([
    User.updateMany(
      { memberships: { $elemMatch: { organizationId: orgObjId, departmentId: doc._id } } },
      { $unset: { "memberships.$[m].departmentId": 1 } },
      { arrayFilters: [{ "m.organizationId": orgObjId, "m.departmentId": doc._id }] },
    ),
    Customer.updateMany(
      { organizationId: orgObjId, departmentId: doc._id },
      { $unset: { departmentId: 1 } },
    ),
    Item.updateMany(
      { organizationId: orgObjId, departmentId: doc._id },
      { $unset: { departmentId: 1 } },
    ),
  ]);
  await doc.deleteOne();
}
