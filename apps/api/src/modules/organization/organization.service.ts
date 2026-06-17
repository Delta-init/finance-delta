import type { UpdateOrganizationInput, OrganizationSettings } from "@delta/shared";
import { AppError } from "../../lib/http";
import { Organization, type OrganizationDoc } from "./organization.model";

function toDTO(doc: OrganizationDoc & { _id: unknown; updatedAt: Date }): OrganizationSettings {
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
    updatedAt: doc.updatedAt.toISOString(),
  };
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
  return toDTO(doc as unknown as OrganizationDoc & { _id: unknown; updatedAt: Date });
}
