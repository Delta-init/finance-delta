import { z } from "zod";

export const TAX_SYSTEMS = ["vat", "gst", "sales_tax", "wht", "none", "custom"] as const;
export type TaxSystem = (typeof TAX_SYSTEMS)[number];

export const TAX_SYSTEM_META: Record<TaxSystem, { label: string; defaultLabel: string }> = {
  vat:       { label: "VAT (Value Added Tax)",      defaultLabel: "VAT"        },
  gst:       { label: "GST (Goods & Services Tax)", defaultLabel: "GST"        },
  sales_tax: { label: "Sales Tax",                  defaultLabel: "Sales Tax"  },
  wht:       { label: "Withholding Tax",             defaultLabel: "WHT"        },
  none:      { label: "No Tax",                      defaultLabel: "Tax"        },
  custom:    { label: "Custom",                      defaultLabel: "Tax"        },
};

export type TaxPresetItem = {
  label: string;
  code: string;
  rate: number;
  isDefault: boolean;
  appliesTo: "sales" | "purchases" | "both";
};

export const TAX_SYSTEM_PRESETS: Record<TaxSystem, TaxPresetItem[]> = {
  vat:       [{ label: "VAT",              code: "VAT", rate: 5,  isDefault: true,  appliesTo: "both"      }],
  gst:       [{ label: "GST",              code: "GST", rate: 18, isDefault: true,  appliesTo: "both"      }],
  sales_tax: [{ label: "Sales Tax",        code: "VAT", rate: 0,  isDefault: true,  appliesTo: "sales"     }],
  wht:       [{ label: "Withholding Tax",  code: "WHT", rate: 5,  isDefault: false, appliesTo: "purchases" }],
  none:      [],
  custom:    [],
};

export const taxConfigItemSchema = z.object({
  label:     z.string().min(1, "Label required").max(50),
  code:      z.string().min(1, "Code required").max(20),
  rate:      z.coerce.number().min(0).max(100),
  isDefault: z.boolean().default(false),
  appliesTo: z.enum(["sales", "purchases", "both"]).default("both"),
});
export type TaxConfigItem = z.infer<typeof taxConfigItemSchema>;

export const upsertTaxConfigSchema = z.object({
  taxSystem: z.enum(TAX_SYSTEMS).default("vat"),
  taxLabel:  z.string().min(1, "Tax label required").max(20).default("VAT"),
  taxRates:  z.array(taxConfigItemSchema).max(10),
});
export type UpsertTaxConfigInput = z.infer<typeof upsertTaxConfigSchema>;

export const taxConfigSchema = z.object({
  taxSystem: z.enum(TAX_SYSTEMS),
  taxLabel:  z.string(),
  taxRates:  z.array(taxConfigItemSchema),
});
export type TaxConfig = z.infer<typeof taxConfigSchema>;
