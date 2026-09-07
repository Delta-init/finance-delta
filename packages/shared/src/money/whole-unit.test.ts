import { describe, expect, it } from "bun:test";
import { displayTaxSplit, formatMoney, isWholeUnitCurrency } from "./index";

/**
 * Indian invoices are written in whole rupees.
 *
 * Presentation only — the stored figures keep their paise, because the
 * arithmetic has to stay exact whatever the paper says. What must hold is that
 * the printed column adds up: an invoice whose parts are a rupee short of its
 * own total is worse than one with decimals on it.
 */
describe("whole-unit currencies", () => {
  it("prints rupees without paise and dirhams with fils", () => {
    expect(formatMoney(2_118_644, "INR")).toBe("INR 21,186");
    expect(formatMoney(105_050, "AED")).toBe("AED 1,050.50");
  });

  it("knows which currencies are written whole", () => {
    expect(isWholeUnitCurrency("INR")).toBe(true);
    expect(isWholeUnitCurrency("inr")).toBe(true);
    expect(isWholeUnitCurrency("AED")).toBe(false);
  });

  /** The sample invoice: 25,000 inclusive of 18%, split 9% + 9%. */
  it("splits the sample invoice the way the sample does", () => {
    const split = displayTaxSplit(
      25_000_00,
      [{ code: "CGST", amountMinor: 1_906_78 }, { code: "SGST", amountMinor: 1_906_78 }],
      "INR",
    );
    expect(split.taxableMinor).toBe(21_186_00);
    expect(split.taxes.map((t) => t.amountMinor)).toEqual([1_907_00, 1_907_00]);
  });

  /**
   * The case that rounding each part separately gets wrong.
   *
   * 1,000 inclusive of 18% is 847.46 + 76.27 + 76.27. Rounded on their own
   * those print 847 + 76 + 76 = 999 against a total of 1,000.
   */
  it("keeps the printed parts adding up to the total", () => {
    const split = displayTaxSplit(
      1_000_00,
      [{ code: "CGST", amountMinor: 76_27 }, { code: "SGST", amountMinor: 76_27 }],
      "INR",
    );
    const sum = split.taxableMinor + split.taxes.reduce((s, t) => s + t.amountMinor, 0);
    expect(sum).toBe(1_000_00);
    expect(split.taxableMinor).toBe(848_00);
  });

  it("leaves a currency with decimals exactly as it was", () => {
    const taxes = [{ code: "VAT", amountMinor: 61_91 }];
    const split = displayTaxSplit(1_300_00, taxes, "AED");
    expect(split.taxes).toEqual(taxes);
    expect(split.taxableMinor).toBe(1_238_09);
  });
});
