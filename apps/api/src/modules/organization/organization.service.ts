import type { UpdateOrganizationInput, OrganizationSettings, UpsertTaxConfigInput, TaxConfig } from "@delta/shared";
import { AppError } from "../../lib/http";
import { Organization, type OrganizationDoc } from "./organization.model";

type AnyDoc = OrganizationDoc & { _id: unknown; updatedAt: Date };

function toDTO(doc: AnyDoc): OrganizationSettings {
  const d = doc as unknown as Record<string, unknown>;
  return {
    id: String(doc._id),
    name: doc.name,
    legalName: doc.legalName ?? "",
    baseCurrency: doc.baseCurrency ?? "AED",
    branding: {
      logoUrl: doc.branding?.logoUrl ?? "",
      primaryColor: doc.branding?.primaryColor ?? "",
      footerText: doc.branding?.footerText ?? "",
    },
    reminderIntervals: (doc.reminderIntervals as number[] | undefined) ?? [-3, 1, 7],
    taxSystem: (d.taxSystem as OrganizationSettings["taxSystem"]) ?? "vat",
    taxLabel: (d.taxLabel as string) ?? "VAT",
    taxRates: ((d.taxRates as unknown[]) ?? []) as OrganizationSettings["taxRates"],
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export interface OrgMembershipItem {
  id: string;
  name: string;
  baseCurrency: string;
  roleKey: string;
  roleName: string;
}

/** Returns all orgs the current user is an active member of. */
export async function getMyOrganizations(userId: string): Promise<OrgMembershipItem[]> {
  const { User } = await import("../user/user.model");
  const { Role } = await import("../role/role.model");

  const user = await User.findById(userId);
  if (!user) throw new AppError("NOT_FOUND", "User not found");

  const active = user.memberships.filter((m) => m.status === "active");
  const results: OrgMembershipItem[] = [];

  for (const m of active) {
    const [org, role] = await Promise.all([
      Organization.findById(m.organizationId).select("name baseCurrency"),
      Role.findById(m.roleId).select("key name"),
    ]);
    if (!org || !role) continue;
    results.push({
      id: org._id.toString(),
      name: org.name,
      baseCurrency: (org.baseCurrency as string) ?? "AED",
      roleKey: role.key,
      roleName: role.name,
    });
  }
  return results;
}

export async function getOrganization(orgId: string): Promise<OrganizationSettings> {
  const doc = await Organization.findById(orgId);
  if (!doc) throw new AppError("NOT_FOUND", "Organization not found");
  return toDTO(doc as unknown as OrganizationDoc & { _id: unknown; updatedAt: Date });
}

export async function updateOrganization(
  orgId: string,
  input: UpdateOrganizationInput,
): Promise<OrganizationSettings> {
  const flat: Record<string, unknown> = {};
  if (input.name !== undefined) flat.name = input.name;
  if (input.legalName !== undefined) flat.legalName = input.legalName;
  if (input.baseCurrency !== undefined) flat.baseCurrency = input.baseCurrency;
  if (input.branding?.logoUrl !== undefined) flat["branding.logoUrl"] = input.branding.logoUrl;
  if (input.branding?.primaryColor !== undefined) flat["branding.primaryColor"] = input.branding.primaryColor;
  if (input.branding?.footerText !== undefined) flat["branding.footerText"] = input.branding.footerText;
  if (input.reminderIntervals !== undefined) flat.reminderIntervals = input.reminderIntervals;

  const doc = await Organization.findByIdAndUpdate(orgId, { $set: flat }, { new: true, runValidators: true });
  if (!doc) throw new AppError("NOT_FOUND", "Organization not found");
  return toDTO(doc as unknown as AnyDoc);
}

export async function getTaxConfig(orgId: string): Promise<TaxConfig> {
  const doc = await Organization.findById(orgId);
  if (!doc) throw new AppError("NOT_FOUND", "Organization not found");
  const d = doc as unknown as Record<string, unknown>;
  return {
    taxSystem: (d.taxSystem as TaxConfig["taxSystem"]) ?? "vat",
    taxLabel: (d.taxLabel as string) ?? "VAT",
    taxRates: ((d.taxRates as unknown[]) ?? []) as TaxConfig["taxRates"],
  };
}

export async function upsertTaxConfig(orgId: string, input: UpsertTaxConfigInput): Promise<TaxConfig> {
  const doc = await Organization.findByIdAndUpdate(
    orgId,
    { $set: { taxSystem: input.taxSystem, taxLabel: input.taxLabel, taxRates: input.taxRates } },
    { new: true, runValidators: true },
  );
  if (!doc) throw new AppError("NOT_FOUND", "Organization not found");
  const d = doc as unknown as Record<string, unknown>;
  return {
    taxSystem: (d.taxSystem as TaxConfig["taxSystem"]) ?? "vat",
    taxLabel: (d.taxLabel as string) ?? "VAT",
    taxRates: ((d.taxRates as unknown[]) ?? []) as TaxConfig["taxRates"],
  };
}
