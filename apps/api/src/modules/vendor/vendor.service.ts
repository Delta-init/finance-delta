import { Types } from "mongoose";
import type { CreateVendorInput, UpdateVendorInput, Vendor as VendorDTO, VendorQuery, Paginated } from "@delta/shared";
import { AppError } from "../../lib/http";
import { buildSort, pageMeta, searchOr, skipFor } from "../../lib/paginate";
import { resolveTagIds, toTagRefs } from "../../lib/tags";
import { Vendor, type VendorDoc } from "./vendor.model";
import { Organization } from "../organization/organization.model";
import { nextNumber } from "../sequence/sequence.service";

function toDTO(doc: VendorDoc): VendorDTO {
  const d = doc as unknown as Record<string, unknown>;
  return {
    id: doc._id.toString(),
    vendorCode: doc.vendorCode,
    name: doc.name,
    email: doc.email,
    phone: doc.phone,
    companyName: (doc.companyName as string) ?? "",
    currency: (doc.currency as string) ?? "AED",
    vatNumber: (d.vatNumber as string) ?? "",
    billingAddress: (() => {
      const a = (d.billingAddress ?? {}) as Record<string, string>;
      return { street: a.street ?? "", city: a.city ?? "", state: a.state ?? "", zip: a.zip ?? "", country: a.country ?? "" };
    })(),
    status: (doc.status as "active" | "archived") ?? "active",
    tags: toTagRefs(doc.tagIds),
    createdAt: doc.createdAt.toISOString(),
  };
}

const SORT = {
  code: "vendorCode",
  name: "name",
  company: "companyName",
  email: "email",
  status: "status",
  createdAt: "createdAt",
} as const;

export async function listVendors(orgId: string, query: VendorQuery): Promise<Paginated<VendorDTO>> {
  const filter: Record<string, unknown> = { organizationId: orgId };
  const or = searchOr(query.q, ["name", "email", "companyName", "phone", "vendorCode"]);
  if (or) filter.$or = or;
  if (query.status) filter.status = query.status;
  if (query.tagIds?.length) filter.tagIds = { $in: query.tagIds };

  const sort = buildSort(SORT, query.sort, query.dir);
  const [rows, total] = await Promise.all([
    Vendor.find(filter).populate("tagIds", "name color").sort(sort)
      .skip(skipFor(query.page, query.pageSize)).limit(query.pageSize),
    Vendor.countDocuments(filter),
  ]);
  return { data: rows.map((r) => toDTO(r as unknown as VendorDoc)), meta: pageMeta(total, query.page, query.pageSize) };
}

export async function getVendor(orgId: string, id: string): Promise<VendorDTO> {
  const doc = await Vendor.findOne({ _id: id, organizationId: orgId }).populate("tagIds", "name color");
  if (!doc) throw new AppError("NOT_FOUND", "Vendor not found");
  return toDTO(doc as unknown as VendorDoc);
}

export async function createVendor(orgId: string, input: CreateVendorInput): Promise<VendorDTO> {
  const exists = await Vendor.exists({ organizationId: orgId, email: input.email });
  if (exists) throw new AppError("CONFLICT", "A vendor with this email already exists");

  const org = await Organization.findById(orgId);
  const currency = input.currency ?? org?.baseCurrency ?? "AED";
  const vendorCode = await nextNumber(orgId, "vendor", "VEND-");
  const tagIds = await resolveTagIds(orgId, input.tagIds);

  const doc = await Vendor.create({
    organizationId: new Types.ObjectId(orgId),
    vendorCode,
    name: input.name,
    email: input.email,
    phone: input.phone,
    companyName: input.companyName ?? "",
    currency,
    vatNumber: input.vatNumber ?? "",
    billingAddress: input.billingAddress ?? {},
    tagIds,
  });
  await doc.populate("tagIds", "name color");
  return toDTO(doc as unknown as VendorDoc);
}

export async function updateVendor(orgId: string, id: string, input: UpdateVendorInput): Promise<VendorDTO> {
  const doc = await Vendor.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Vendor not found");

  if (input.name !== undefined) doc.name = input.name;
  if (input.email !== undefined) doc.email = input.email;
  if (input.phone !== undefined) doc.phone = input.phone;
  if (input.companyName !== undefined) doc.companyName = input.companyName;
  if (input.currency !== undefined) doc.currency = input.currency;
  if (input.status !== undefined) doc.status = input.status;
  if (input.tagIds !== undefined) doc.set("tagIds", await resolveTagIds(orgId, input.tagIds));

  const d = doc as unknown as Record<string, unknown>;
  if (input.vatNumber !== undefined) d.vatNumber = input.vatNumber;
  if (input.billingAddress !== undefined) d.billingAddress = input.billingAddress;

  await doc.save();
  await doc.populate("tagIds", "name color");
  return toDTO(doc as unknown as VendorDoc);
}

export async function deleteVendor(orgId: string, id: string): Promise<void> {
  const doc = await Vendor.findOne({ _id: id, organizationId: orgId });
  if (!doc) throw new AppError("NOT_FOUND", "Vendor not found");
  await doc.deleteOne();
}
