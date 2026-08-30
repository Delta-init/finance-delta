import { describe, expect, test } from "bun:test";
import { roundingAdjustmentMinor, sumInvoiceTotals } from "./index";

describe("roundingAdjustmentMinor", () => {
  test("rounds up past the halfway point and down before it", () => {
    // 1179.66 → 1180.00
    expect(roundingAdjustmentMinor(117966)).toBe(34);
    // 1179.20 → 1179.00
    expect(roundingAdjustmentMinor(117920)).toBe(-20);
  });

  test("a total already whole is left alone", () => {
    expect(roundingAdjustmentMinor(118000)).toBe(0);
    expect(roundingAdjustmentMinor(0)).toBe(0);
  });

  test("exactly half a unit rounds up", () => {
    // 10.50 → 11.00, not 10.00
    expect(roundingAdjustmentMinor(1050)).toBe(50);
  });

  test("the adjustment always lands on a whole unit", () => {
    for (let minor = 0; minor <= 400; minor++) {
      const rounded = minor + roundingAdjustmentMinor(minor);
      expect(Math.abs(rounded) % 100).toBe(0);
      // and never moves the figure by more than half a unit
      expect(Math.abs(roundingAdjustmentMinor(minor))).toBeLessThanOrEqual(50);
    }
  });

  test("negative totals round symmetrically", () => {
    // A credit of 1179.66 rounds to 1180.00 owed back, not to 1179.
    expect(-117966 + roundingAdjustmentMinor(-117966)).toBe(-118000);
    // Math.abs first: a negative multiple of 100 gives -0 for the remainder,
    // which toBe distinguishes from 0.
    expect(Math.abs(-117920 + roundingAdjustmentMinor(-117920)) % 100).toBe(0);
  });
});

describe("rounding an invoice's totals", () => {
  // The figures from a GST invoice: 1000.00 ex-tax at 9% + 9%.
  const lines = [
    {
      description: "Course",
      quantity: 1,
      unitPriceMinor: 99966,
      discountPct: 0,
      taxes: [
        { code: "CGST", rate: 9 },
        { code: "SGST", rate: 9 },
      ],
    },
  ];

  test("subtotal, tax and round-off still reconcile to the rounded total", () => {
    const totals = sumInvoiceTotals(lines);
    const adjustment = roundingAdjustmentMinor(totals.totalMinor);
    const rounded = totals.totalMinor + adjustment;

    expect(rounded % 100).toBe(0);
    // The whole point: what the client is asked to pay is what the parts add to.
    expect(totals.subtotalMinor + totals.taxTotalMinor + adjustment).toBe(rounded);
  });

  test("the tax breakdown is untouched by rounding", () => {
    const totals = sumInvoiceTotals(lines);
    const codes = totals.taxBreakdown.map((t) => t.code).sort();
    expect(codes).toEqual(["CGST", "SGST"]);
    // Rounding adjusts the total, never a tax figure — those are what is owed
    // to a tax authority and must match the return.
    expect(totals.taxBreakdown.reduce((s, t) => s + t.amountMinor, 0)).toBe(totals.taxTotalMinor);
  });
});
