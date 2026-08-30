import { z } from "zod";
import { taxConfigItemSchema, taxConfigSchema, upsertTaxConfigSchema, TAX_SYSTEMS, type TaxSystem } from "./tax-config.schema";
export { taxConfigItemSchema, taxConfigSchema, upsertTaxConfigSchema, TAX_SYSTEMS };

/**
 * What an organization has to say about itself on a document it issues.
 *
 * An invoice is a legal record before it is a screen, and the half describing
 * who issued it was never asked for anywhere: the address, the phone number and
 * the tax registration are what make it an invoice rather than a statement of
 * what somebody owes. All of it is optional so that an organization set up
 * before these fields existed keeps working, and every renderer leaves out what
 * it has not been given rather than printing an empty heading.
 */
export const orgAddressSchema = z.object({
  line1: z.string().max(200).optional().default(""),
  line2: z.string().max(200).optional().default(""),
  city: z.string().max(100).optional().default(""),
  state: z.string().max(100).optional().default(""),
  postcode: z.string().max(20).optional().default(""),
  country: z.string().max(100).optional().default(""),
});
export type OrgAddress = z.infer<typeof orgAddressSchema>;

/** Defaults an invoice takes from the organization when nothing overrides them. */
export const invoiceDefaultsSchema = z.object({
  /** "TAX INVOICE" where the seller is registered, "INVOICE" where it is not. */
  title: z.string().max(60).optional().default(""),
  /** Numbering. Read when the document is rendered, not baked into the stored number. */
  prefix: z.string().max(20).optional().default(""),
  numberPad: z.coerce.number().int().min(1).max(10).optional().default(5),
  terms: z.string().max(2000).optional().default(""),
  /** Which account clients are told to pay into. Empty means print no bank block. */
  bankAccountId: z.string().optional().default(""),
  /**
   * Settle in whole units of currency, showing the fraction as "Round Off".
   * Normal on an Indian invoice, wrong on a dirham one, so it is a choice.
   */
  roundTotals: z.boolean().optional().default(false),
  /** Falls into the HSN/SAC box on every new line. */
  hsnSac: z.string().max(20).optional().default(""),
});
export type InvoiceDefaults = z.infer<typeof invoiceDefaultsSchema>;

export const updateOrganizationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  legalName: z.string().max(200).optional(),
  baseCurrency: z.string().min(3).max(3).optional(),
  branding: z
    .object({
      logoUrl: z.string().url("Must be a valid URL").or(z.literal("")).optional(),
      primaryColor: z.string().max(20).optional(),
      footerText: z.string().max(500).optional(),
    })
    .optional(),
  address: orgAddressSchema.partial().optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email("Must be a valid email").or(z.literal("")).optional(),
  website: z.string().max(200).optional(),
  /** GSTIN, TRN, VAT number — one field, labelled by the tax system in use. */
  taxRegistrationNumber: z.string().max(40).optional(),
  /** CIN or equivalent company registration number. */
  registrationNumber: z.string().max(40).optional(),
  invoiceDefaults: invoiceDefaultsSchema.partial().optional(),
  reminderIntervals: z.array(z.coerce.number().int().min(-365).max(365)).max(10).optional(),
});
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const organizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  legalName: z.string(),
  baseCurrency: z.string(),
  branding: z.object({
    logoUrl: z.string(),
    primaryColor: z.string(),
    footerText: z.string(),
  }),
  address: orgAddressSchema,
  phone: z.string().default(""),
  email: z.string().default(""),
  website: z.string().default(""),
  taxRegistrationNumber: z.string().default(""),
  registrationNumber: z.string().default(""),
  invoiceDefaults: invoiceDefaultsSchema,
  reminderIntervals: z.array(z.number()),
  taxSystem: z.enum(TAX_SYSTEMS).default("vat"),
  taxLabel: z.string().default("VAT"),
  taxRates: z.array(taxConfigItemSchema).default([]),
  updatedAt: z.string(),
});
export type OrganizationSettings = z.infer<typeof organizationSchema>;

/**
 * What to call the seller's tax registration on screen and in print.
 *
 * The number itself is stored in one field because an organization only ever
 * has one; only the name for it changes with where the organization trades, so
 * asking for "GSTIN" in India and "TRN" in the UAE costs nothing but stops the
 * form reading like it was written for somebody else's country.
 */
export function taxNumberLabel(taxSystem: TaxSystem | undefined | null): string {
  switch (taxSystem) {
    case "gst": return "GSTIN";
    case "vat": return "TRN";
    default: return "Tax reg. no.";
  }
}

/** Whether the seller has enough registration to head the document "TAX INVOICE". */
export function defaultInvoiceTitle(
  taxSystem: TaxSystem | undefined | null,
  taxRegistrationNumber: string | undefined | null,
): string {
  const registered = Boolean(taxRegistrationNumber?.trim());
  const taxed = taxSystem !== "none" && taxSystem != null;
  return registered && taxed ? "TAX INVOICE" : "INVOICE";
}

/** The address as printed: the parts that are filled in, in postal order. */
export function formatOrgAddress(address: Partial<OrgAddress> | undefined | null): string[] {
  if (!address) return [];
  const cityLine = [address.city, address.state, address.postcode].filter(Boolean).join(", ");
  return [address.line1, address.line2, cityLine, address.country]
    .map((l) => (l ?? "").trim())
    .filter((l) => l.length > 0);
}
