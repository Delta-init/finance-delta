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
    address: {
      line1: (d.address as Record<string, string>)?.line1 ?? "",
      line2: (d.address as Record<string, string>)?.line2 ?? "",
      city: (d.address as Record<string, string>)?.city ?? "",
      state: (d.address as Record<string, string>)?.state ?? "",
      postcode: (d.address as Record<string, string>)?.postcode ?? "",
      country: (d.address as Record<string, string>)?.country ?? "",
    },
    phone: (d.phone as string) ?? "",
    email: (d.email as string) ?? "",
    website: (d.website as string) ?? "",
    taxRegistrationNumber: (d.taxRegistrationNumber as string) ?? "",
    registrationNumber: (d.registrationNumber as string) ?? "",
    invoiceDefaults: {
      title: (d.invoiceDefaults as Record<string, unknown>)?.title as string ?? "",
      prefix: (d.invoiceDefaults as Record<string, unknown>)?.prefix as string ?? "",
      numberPad: ((d.invoiceDefaults as Record<string, unknown>)?.numberPad as number) ?? 5,
      terms: (d.invoiceDefaults as Record<string, unknown>)?.terms as string ?? "",
      bankAccountId: (d.invoiceDefaults as Record<string, unknown>)?.bankAccountId as string ?? "",
      roundTotals: Boolean((d.invoiceDefaults as Record<string, unknown>)?.roundTotals),
      hsnSac: (d.invoiceDefaults as Record<string, unknown>)?.hsnSac as string ?? "",
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
  // Dotted paths rather than whole sub-documents: a form that sends only the
  // city must not blank out the rest of the address it never asked about.
  for (const k of ["line1", "line2", "city", "state", "postcode", "country"] as const) {
    if (input.address?.[k] !== undefined) flat[`address.${k}`] = input.address[k];
  }
  if (input.phone !== undefined) flat.phone = input.phone;
  if (input.email !== undefined) flat.email = input.email;
  if (input.website !== undefined) flat.website = input.website;
  if (input.taxRegistrationNumber !== undefined) flat.taxRegistrationNumber = input.taxRegistrationNumber;
  if (input.registrationNumber !== undefined) flat.registrationNumber = input.registrationNumber;
  for (const k of ["title", "prefix", "numberPad", "terms", "bankAccountId", "roundTotals", "hsnSac"] as const) {
    if (input.invoiceDefaults?.[k] !== undefined) flat[`invoiceDefaults.${k}`] = input.invoiceDefaults[k];
  }
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

/**
 * How this organization numbers its invoices.
 *
 * Read when a number is allocated rather than stored on the sequence, because
 * `nextNumber` only ever writes its prefix on insert: an organization that has
 * already issued an invoice would otherwise keep its first prefix forever, with
 * the setting quietly having no effect.
 *
 * Numbers already issued are left alone. An invoice is identified by the number
 * on it — in a client's records as much as ours — so changing the setting
 * applies to what comes next and never rewrites what has gone out.
 */
export async function invoiceNumberingFor(
  orgId: string,
): Promise<{ prefix: string; pad: number }> {
  const doc = await Organization.findById(orgId).select("invoiceDefaults").lean();
  const d = (doc as Record<string, unknown> | null)?.invoiceDefaults as
    | Record<string, unknown>
    | undefined;
  const prefix = ((d?.prefix as string) ?? "").trim();
  const pad = (d?.numberPad as number) ?? 5;
  return { prefix: prefix || "IN-", pad: pad >= 1 && pad <= 10 ? pad : 5 };
}

/**
 * The invoice defaults that shape a document's figures rather than its wording.
 *
 * Read at the point an invoice's totals are built, for the same reason as the
 * numbering: an organization that turns rounding on expects the next invoice to
 * be rounded, not the ones it has already sent.
 */
export async function invoiceComputationDefaults(
  orgId: string,
): Promise<{ roundTotals: boolean; hsnSac: string }> {
  const doc = await Organization.findById(orgId).select("invoiceDefaults").lean();
  const d = (doc as Record<string, unknown> | null)?.invoiceDefaults as
    | Record<string, unknown>
    | undefined;
  return {
    roundTotals: Boolean(d?.roundTotals),
    hsnSac: (d?.hsnSac as string) ?? "",
  };
}
