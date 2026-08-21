import { describe, it, expect } from "bun:test";
import {
  computeLine,
  sumTotals,
  formatMoney,
  toMinor,
  computeInvoiceLine,
  sumInvoiceTotals,
} from "./index";

describe("computeLine (single-tax)", () => {
  it("computes subtotal, discount, tax and total in minor units", () => {
    // 3 × 100.00, 10% discount, 5% tax
    const b = computeLine({ quantity: 3, unitPriceMinor: 10000, discountPct: 10, taxPct: 5 });
    expect(b.lineSubtotalMinor).toBe(30000);
    expect(b.discountMinor).toBe(3000);
    expect(b.taxableMinor).toBe(27000);
    expect(b.taxMinor).toBe(1350);
    expect(b.lineTotalMinor).toBe(28350);
  });

  it("defaults discount and tax to zero", () => {
    const b = computeLine({ quantity: 2, unitPriceMinor: 5000 });
    expect(b.discountMinor).toBe(0);
    expect(b.taxMinor).toBe(0);
    expect(b.lineTotalMinor).toBe(10000);
  });

  it("rounds tax to the nearest minor unit (no float drift)", () => {
    // taxable 33.33 × 3 = 9999 minor, 5% = 499.95 → rounds to 500
    const b = computeLine({ quantity: 3, unitPriceMinor: 3333, taxPct: 5 });
    expect(b.taxableMinor).toBe(9999);
    expect(b.taxMinor).toBe(500);
  });

  it("handles a 100% discount", () => {
    const b = computeLine({ quantity: 1, unitPriceMinor: 10000, discountPct: 100, taxPct: 5 });
    expect(b.taxableMinor).toBe(0);
    expect(b.taxMinor).toBe(0);
    expect(b.lineTotalMinor).toBe(0);
  });
});

describe("sumTotals", () => {
  it("aggregates multiple lines", () => {
    const t = sumTotals([
      { quantity: 1, unitPriceMinor: 10000, taxPct: 5 },
      { quantity: 2, unitPriceMinor: 5000, discountPct: 10 },
    ]);
    expect(t.subtotalMinor).toBe(20000);
    expect(t.discountTotalMinor).toBe(1000);
    expect(t.taxTotalMinor).toBe(500);
    expect(t.totalMinor).toBe(19500);
  });

  it("returns zeros for an empty list", () => {
    expect(sumTotals([])).toEqual({
      subtotalMinor: 0,
      discountTotalMinor: 0,
      taxTotalMinor: 0,
      totalMinor: 0,
    });
  });
});

describe("toMinor / formatMoney", () => {
  it("parses major units (number and string) to minor", () => {
    expect(toMinor(10.5)).toBe(1050);
    expect(toMinor("10.50")).toBe(1050);
    expect(toMinor("0.1")).toBe(10);
  });

  it("treats non-finite input as zero", () => {
    expect(toMinor("abc")).toBe(0);
    expect(toMinor(Number.NaN)).toBe(0);
  });

  it("formats minor units with currency and two decimals", () => {
    expect(formatMoney(105050, "AED")).toBe("AED 1,050.50");
    expect(formatMoney(0)).toBe("AED 0.00");
    expect(formatMoney(500000, "INR")).toBe("INR 5,000.00");
  });
});

describe("computeInvoiceLine (multi-tax)", () => {
  it("applies CGST + SGST as separate components on the same taxable base", () => {
    // ₹10,000 line, CGST 9% + SGST 9%
    const b = computeInvoiceLine({
      quantity: 1,
      unitPriceMinor: 1000000,
      taxes: [
        { code: "CGST", rate: 9 },
        { code: "SGST", rate: 9 },
      ],
    });
    expect(b.taxableMinor).toBe(1000000);
    expect(b.taxes).toEqual([
      { code: "CGST", rate: 9, amountMinor: 90000 },
      { code: "SGST", rate: 9, amountMinor: 90000 },
    ]);
    expect(b.taxTotalMinor).toBe(180000);
    expect(b.lineTotalMinor).toBe(1180000);
  });

  it("applies discount before tax", () => {
    const b = computeInvoiceLine({
      quantity: 1,
      unitPriceMinor: 100000,
      discountPct: 20,
      taxes: [{ code: "VAT", rate: 5 }],
    });
    expect(b.taxableMinor).toBe(80000);
    expect(b.taxTotalMinor).toBe(4000);
    expect(b.lineTotalMinor).toBe(84000);
  });

  it("back-calculates the taxable base when prices are tax-inclusive", () => {
    // 105.00 inclusive of 5% VAT → taxable 100.00, tax 5.00
    const b = computeInvoiceLine({
      quantity: 1,
      unitPriceMinor: 10500,
      taxes: [{ code: "VAT", rate: 5 }],
      taxInclusive: true,
    });
    expect(b.taxableMinor).toBe(10000);
    expect(b.taxTotalMinor).toBe(500);
    expect(b.lineTotalMinor).toBe(10500);
  });

  it("treats a line with no taxes as tax-free", () => {
    const b = computeInvoiceLine({ quantity: 2, unitPriceMinor: 2500 });
    expect(b.taxTotalMinor).toBe(0);
    expect(b.lineTotalMinor).toBe(5000);
  });
});

describe("sumInvoiceTotals", () => {
  it("aggregates the per-code tax breakdown across lines", () => {
    const t = sumInvoiceTotals([
      { quantity: 1, unitPriceMinor: 1000000, taxes: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }] },
      { quantity: 1, unitPriceMinor: 500000, taxes: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }] },
    ]);
    expect(t.subtotalMinor).toBe(1500000);
    expect(t.taxTotalMinor).toBe(270000);
    expect(t.totalMinor).toBe(1770000);
    const byCode = Object.fromEntries(t.taxBreakdown.map((x) => [x.code, x.amountMinor]));
    expect(byCode).toEqual({ CGST: 135000, SGST: 135000 });
  });

  it("keeps distinct tax codes separate in the breakdown", () => {
    const t = sumInvoiceTotals([
      { quantity: 1, unitPriceMinor: 100000, taxes: [{ code: "VAT", rate: 5 }] },
      { quantity: 1, unitPriceMinor: 100000, taxes: [{ code: "IGST", rate: 18 }] },
    ]);
    const codes = t.taxBreakdown.map((x) => x.code).sort();
    expect(codes).toEqual(["IGST", "VAT"]);
  });

  it("shows a net-of-tax subtotal for tax-inclusive prices (any tax code)", () => {
    // Subtotal + Tax must equal Total, regardless of the tax code.
    const vat = sumInvoiceTotals([
      { quantity: 1, unitPriceMinor: 10500, taxes: [{ code: "VAT", rate: 5 }], taxInclusive: true },
    ]);
    expect(vat.subtotalMinor).toBe(10000);
    expect(vat.taxTotalMinor).toBe(500);
    expect(vat.totalMinor).toBe(10500);
    expect(vat.subtotalMinor - vat.discountTotalMinor + vat.taxTotalMinor).toBe(vat.totalMinor);

    const gst = sumInvoiceTotals([
      { quantity: 1, unitPriceMinor: 11800, taxes: [{ code: "CGST", rate: 9 }, { code: "SGST", rate: 9 }], taxInclusive: true },
    ]);
    expect(gst.subtotalMinor).toBe(10000);
    expect(gst.taxTotalMinor).toBe(1800);
    expect(gst.totalMinor).toBe(11800);
    expect(gst.subtotalMinor - gst.discountTotalMinor + gst.taxTotalMinor).toBe(gst.totalMinor);
  });
});
