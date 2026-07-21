import { Types } from "mongoose";
import type {
  CreateCustomerInput,
  Customer as CustomerDTO,
  CustomerAddress,
  CustomerQuery,
  Paginated,
  UpdateCustomerInput,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { resolveTagIds, toTagRefs } from "../../lib/tags";
import { Customer, type CustomerDoc } from "./customer.model";
import { Organization } from "../organization/organization.model";
import { Invoice } from "../invoice/invoice.model";
import { Department } from "../department/department.model";
import { nextNumber } from "../sequence/sequence.service";

/** Maps a (possibly populated) departmentId to the DTO ref. */
function toDepartmentRef(raw: unknown): { id: string; name: string } | null {
  if (!raw) return null;
  const d = raw as { _id?: Types.ObjectId; name?: string };
  if (d._id && typeof d.name === "string") return { id: d._id.toString(), name: d.name };
  return null;
}

async function requireOrgDepartment(orgId: string, departmentId: string) {
  const dept = await Department.findOne({ _id: departmentId, organizationId: orgId });
  if (!dept) throw new AppError("VALIDATION_ERROR", "Invalid department selected");
  return dept;
}

function toAddress(raw: unknown): CustomerAddress {
  const a = (raw ?? {}) as Record<string, string>;
  return {
    street: a.street ?? "",
    city: a.city ?? "",
    state: a.state ?? "",
    zip: a.zip ?? "",
    country: a.country ?? "",
  };
}

function toDTO(doc: CustomerDoc): CustomerDTO {
  return {
    id: doc._id.toString(),
    customerCode: doc.customerCode,
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    companyName: doc.companyName ?? "",
    currency: doc.currency ?? "AED",
    vatNumber: (doc as unknown as { vatNumber?: string }).vatNumber ?? "",
    discountPct: (doc as unknown as { discountPct?: number }).discountPct ?? 0,
    billingAddress: toAddress((doc as unknown as { billingAddress?: unknown }).billingAddress),
    shippingAddress: toAddress((doc as unknown as { shippingAddress?: unknown }).shippingAddress),
    status: (doc.status as "active" | "archived") ?? "active",
    department: toDepartmentRef((doc as unknown as { departmentId?: unknown }).departmentId),
    tags: toTagRefs(doc.tagIds),
    createdAt: doc.createdAt.toISOString(),
  };
}

const SORT = {
  code: "customerCode",
  name: "name",
  company: "companyName",
  email: "email",
  status: "status",
  createdAt: "createdAt",
} as const;

export async function listCustomers(
  orgId: string,
  query: CustomerQuery,
): Promise<Paginated<CustomerDTO>> {
  const filter: Record<string, unknown> = { organizationId: orgId };
  const or = searchOr(query.q, ["name", "email", "companyName", "phone", "customerCode"]);
  if (or) filter.$or = or;
  if (query.status) filter.status = query.status;
  if (query.tagIds?.length) filter.tagIds = { $in: query.tagIds };

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    Customer.find(filter)
      .populate("tagIds", "name color")
      .populate("departmentId", "name")
      .sort(sort)
      .skip(skipFor(query.page, query.pageSize))
      .limit(query.pageSize),
    Customer.countDocuments(filter),
  ]);
  return {
    data: rows.map((r) => toDTO(r as unknown as CustomerDoc)),
    meta: pageMeta(total, query.page, query.pageSize),
  };
}

export async function getCustomer(orgId: string, id: string): Promise<CustomerDTO> {
  const doc = await Customer.findOne({ _id: id, organizationId: orgId })
    .populate("tagIds", "name color")
    .populate("departmentId", "name");
  if (!doc) throw new AppError("NOT_FOUND", "Customer not found");
  return toDTO(doc as unknown as CustomerDoc);
}

export async function createCustomer(
  orgId: string,
  input: CreateCustomerInput,
): Promise<CustomerDTO> {
  const exists = await Customer.exists({ organizationId: orgId, email: input.email });
  if (exists) throw new AppError("CONFLICT", "A customer with this email already exists");

  const org = await Organization.findById(orgId);
  const currency = input.currency ?? org?.baseCurrency ?? "AED";
  const customerCode = await nextNumber(orgId, "customer", "CUST-");
  const tagIds = await resolveTagIds(orgId, input.tagIds);
  const departmentId = input.departmentId
    ? (await requireOrgDepartment(orgId, input.departmentId))._id
    : undefined;

  const doc = await Customer.create({
    organizationId: new Types.ObjectId(orgId),
    customerCode,
    name: input.name,
    email: input.email,
    phone: input.phone,
    companyName: input.companyName ?? "",
    currency,
    vatNumber: input.vatNumber ?? "",
    discountPct: input.discountPct ?? 0,
    departmentId,
    billingAddress: input.billingAddress ?? {},
    shippingAddress: input.shippingAddress ?? {},
    tagIds,
  });
  await doc.populate("tagIds", "name color");
  await doc.populate("departmentId", "name");
  return toDTO(doc as unknown as CustomerDoc);
}

export async function updateCustomer(
  orgId: string,
  id: string,
  input: UpdateCustomerInput,
): Promise<CustomerDTO> {
  const doc = await Customer.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Customer not found");

  if (input.name !== undefined) doc.name = input.name;
  if (input.email !== undefined) doc.email = input.email;
  if (input.phone !== undefined) doc.phone = input.phone;
  if (input.companyName !== undefined) doc.companyName = input.companyName;
  if (input.currency !== undefined) doc.currency = input.currency;
  if (input.status !== undefined) doc.status = input.status;
  if (input.tagIds !== undefined) doc.set("tagIds", await resolveTagIds(orgId, input.tagIds));
  if (input.departmentId !== undefined) {
    if (input.departmentId) {
      doc.set("departmentId", (await requireOrgDepartment(orgId, input.departmentId))._id);
    } else {
      doc.set("departmentId", undefined);
    }
  }

  const d = doc as unknown as Record<string, unknown>;
  if (input.vatNumber !== undefined) d.vatNumber = input.vatNumber;
  if (input.discountPct !== undefined) d.discountPct = input.discountPct;
  if (input.billingAddress !== undefined) d.billingAddress = input.billingAddress;
  if (input.shippingAddress !== undefined) d.shippingAddress = input.shippingAddress;

  await doc.save();
  await doc.populate("tagIds", "name color");
  await doc.populate("departmentId", "name");
  return toDTO(doc as unknown as CustomerDoc);
}

export async function deleteCustomer(orgId: string, id: string): Promise<void> {
  const doc = await Customer.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Customer not found");
  await doc.deleteOne();
}

export interface CustomerStatementRow {
  id: string;
  type: "invoice";
  number: string;
  date: string;
  dueDate: string;
  status: string;
  totalMinor: number;
  amountPaidMinor: number;
  balanceMinor: number;
  currency: string;
}

export interface CustomerStatement {
  customer: CustomerDTO;
  rows: CustomerStatementRow[];
  summary: {
    totalInvoicedMinor: number;
    totalPaidMinor: number;
    outstandingMinor: number;
    currency: string;
  };
}

export async function getCustomerStatement(
  orgId: string,
  customerId: string,
): Promise<CustomerStatement> {
  const customer = await getCustomer(orgId, customerId);

  const invoices = await Invoice.find({
    organizationId: new Types.ObjectId(orgId),
    customerId: new Types.ObjectId(customerId),
  }).sort({ issueDate: -1 });

  const rows: CustomerStatementRow[] = invoices.map((inv) => {
    const i = inv as unknown as {
      _id: { toString(): string };
      invoiceNumber: string;
      issueDate: Date;
      dueDate: Date;
      status: string;
      totalMinor: number;
      amountPaidMinor: number;
      balanceMinor: number;
      currency: string;
    };
    return {
      id: i._id.toString(),
      type: "invoice" as const,
      number: i.invoiceNumber,
      date: i.issueDate ? i.issueDate.toISOString().slice(0, 10) : "",
      dueDate: i.dueDate ? i.dueDate.toISOString().slice(0, 10) : "",
      status: i.status,
      totalMinor: i.totalMinor ?? 0,
      amountPaidMinor: i.amountPaidMinor ?? 0,
      balanceMinor: i.balanceMinor ?? 0,
      currency: i.currency ?? customer.currency,
    };
  });

  const totalInvoicedMinor = rows.reduce((s, r) => s + r.totalMinor, 0);
  const totalPaidMinor = rows.reduce((s, r) => s + r.amountPaidMinor, 0);
  const outstandingMinor = rows.reduce((s, r) => s + r.balanceMinor, 0);

  return {
    customer,
    rows,
    summary: {
      totalInvoicedMinor,
      totalPaidMinor,
      outstandingMinor,
      currency: customer.currency,
    },
  };
}
