import { describe, it, expect } from "bun:test";
import {
  TAX_SYSTEM_PRESETS,
  taxConfigItemSchema,
  upsertTaxConfigSchema,
} from "./tax-config.schema";

describe("TAX_SYSTEM_PRESETS", () => {
  it("splits GST into CGST 9% + SGST 9% (both default) and IGST 18%", () => {
    const gst = TAX_SYSTEM_PRESETS.gst;
    const byCode = Object.fromEntries(gst.map((r) => [r.code, r]));
    expect(byCode.CGST).toMatchObject({ rate: 9, isDefault: true });
    expect(byCode.SGST).toMatchObject({ rate: 9, isDefault: true });
    expect(byCode.IGST).toMatchObject({ rate: 18, isDefault: false });
  });

  it("intra-state GST defaults sum to 18% (CGST + SGST), matching IGST", () => {
    const defaults = TAX_SYSTEM_PRESETS.gst.filter((r) => r.isDefault);
    const total = defaults.reduce((s, r) => s + r.rate, 0);
    expect(total).toBe(18);
  });

  it("keeps VAT as a single 5% default", () => {
    expect(TAX_SYSTEM_PRESETS.vat).toHaveLength(1);
    expect(TAX_SYSTEM_PRESETS.vat[0]).toMatchObject({ code: "VAT", rate: 5, isDefault: true });
  });

  it("has empty presets for none / custom", () => {
    expect(TAX_SYSTEM_PRESETS.none).toHaveLength(0);
    expect(TAX_SYSTEM_PRESETS.custom).toHaveLength(0);
  });
});

describe("tax config schemas", () => {
  it("accepts a valid rate item and rejects an out-of-range rate", () => {
    expect(taxConfigItemSchema.safeParse({ label: "CGST", code: "CGST", rate: 9 }).success).toBe(true);
    expect(taxConfigItemSchema.safeParse({ label: "X", code: "X", rate: 150 }).success).toBe(false);
  });

  it("caps the number of configured rates at 10", () => {
    const rates = Array.from({ length: 11 }, (_, i) => ({ label: `R${i}`, code: `R${i}`, rate: 1 }));
    expect(upsertTaxConfigSchema.safeParse({ taxSystem: "custom", taxLabel: "Tax", taxRates: rates }).success).toBe(false);
  });
});
