import { describe, expect, it } from "bun:test";
import { computeInvoiceLine, sumInvoiceTotals } from "./index";

/**
 * "Prices include tax", pinned.
 *
 * The rule the whole feature rests on: when a price is tax-inclusive, the
 * amount typed in is what the customer pays. The tax is extracted out of it,
 * so the line total must not move when the toggle is flipped — only the split
 * between net and tax does.
 *
 * A line of 105.00 at 5% is the canonical case: inclusive it is 100.00 + 5.00
 * of tax; exclusive it is 105.00 + 5.25.
 */
const LINE = { quantity: 1, unitPriceMinor: 105_00, taxes: [{ code: "VAT5", rate: 5 }] };

describe("computeInvoiceLine — tax inclusive", () => {
  it("extracts the tax from the price rather than adding to it", () => {
    const b = computeInvoiceLine({ ...LINE, taxInclusive: true });
    expect(b.lineTotalMinor).toBe(105_00);
    expect(b.taxTotalMinor).toBe(5_00);
    expect(b.taxableMinor).toBe(100_00);
  });

  it("adds the tax on top when prices exclude it", () => {
    const b = computeInvoiceLine({ ...LINE, taxInclusive: false });
    expect(b.lineTotalMinor).toBe(110_25);
    expect(b.taxTotalMinor).toBe(5_25);
    expect(b.taxableMinor).toBe(105_00);
  });

  it("keeps subtotal + tax reconciling to the total either way", () => {
    for (const taxInclusive of [true, false]) {
      const t = sumInvoiceTotals([{ ...LINE, taxInclusive }]);
      expect(t.subtotalMinor + t.taxTotalMinor).toBe(t.totalMinor);
    }
  });

  /**
   * A line described by a bare rate rather than per-code taxes.
   *
   * This used to come out at zero tax in both modes: the inclusive branch
   * required a non-empty `taxes[]`, and the exclusive branch read `taxes` too,
   * so `taxPct` reached nothing at all. Credit notes describe every line this
   * way, which is how they ended up untaxed.
   */
  it("falls back to taxPct when no per-code taxes are given", () => {
    const pctOnly = { quantity: 1, unitPriceMinor: 105_00, taxPct: 5 };
    expect(computeInvoiceLine({ ...pctOnly, taxInclusive: true }).taxTotalMinor).toBe(5_00);
    expect(computeInvoiceLine({ ...pctOnly, taxInclusive: true }).lineTotalMinor).toBe(105_00);
    expect(computeInvoiceLine({ ...pctOnly, taxInclusive: false }).taxTotalMinor).toBe(5_25);
    expect(computeInvoiceLine({ ...pctOnly, taxInclusive: false }).lineTotalMinor).toBe(110_25);
  });

  it("prefers per-code taxes over taxPct when both are present", () => {
    // Quotation and sales-order lines carry both; the codes are the real answer
    // and taxPct is a denormalised leftover.
    const b = computeInvoiceLine({
      quantity: 1, unitPriceMinor: 105_00, taxPct: 99,
      taxes: [{ code: "VAT5", rate: 5 }], taxInclusive: true,
    });
    expect(b.taxTotalMinor).toBe(5_00);
  });

  it("charges no tax when neither is given", () => {
    const b = computeInvoiceLine({ quantity: 1, unitPriceMinor: 105_00, taxInclusive: true });
    expect(b.taxTotalMinor).toBe(0);
    expect(b.lineTotalMinor).toBe(105_00);
  });

  it("splits a multi-rate inclusive price across its codes without changing the total", () => {
    const b = computeInvoiceLine({
      quantity: 1,
      unitPriceMinor: 110_00,
      taxes: [{ code: "A", rate: 5 }, { code: "B", rate: 5 }],
      taxInclusive: true,
    });
    expect(b.lineTotalMinor).toBe(110_00);
    expect(b.taxTotalMinor).toBe(10_00);
    expect(b.taxes.map((t) => t.amountMinor)).toEqual([5_00, 5_00]);
  });

  it("takes the discount out of the inclusive price before extracting tax", () => {
    // 210.00 less 50% is 105.00 inclusive, which is 100.00 + 5.00.
    const b = computeInvoiceLine({
      quantity: 1, unitPriceMinor: 210_00, discountPct: 50,
      taxes: [{ code: "VAT5", rate: 5 }], taxInclusive: true,
    });
    expect(b.lineTotalMinor).toBe(105_00);
    expect(b.taxTotalMinor).toBe(5_00);
  });
});

/**
 * A credit note prices the way the invoice it credits did.
 *
 * Credit-note lines carry a bare `taxPct` rather than per-code taxes, and the
 * service used to keep its own arithmetic that always added tax on top. A full
 * credit of a tax-inclusive invoice therefore gave back 110.25 against a line
 * invoiced at 105.00. These pin the two halves of that: the same input, the
 * same basis, the same number.
 */
describe("credit note against a tax-inclusive invoice", () => {
  const creditLine = { quantity: 1, unitPriceMinor: 105_00, discountPct: 0, taxPct: 5 };

  it("credits back exactly what the invoice charged", () => {
    const invoiced = computeInvoiceLine({ ...LINE, taxInclusive: true }).lineTotalMinor;
    const credited = computeInvoiceLine({ ...creditLine, taxInclusive: true }).lineTotalMinor;
    expect(invoiced).toBe(105_00);
    expect(credited).toBe(105_00);
    expect(credited - invoiced).toBe(0);
  });

  it("splits the credit the same way the invoice did", () => {
    const t = sumInvoiceTotals([{ ...creditLine, taxInclusive: true }]);
    expect(t.subtotalMinor).toBe(100_00);
    expect(t.taxTotalMinor).toBe(5_00);
    expect(t.totalMinor).toBe(105_00);
  });

  it("still adds tax on top when the invoice was tax-exclusive", () => {
    const t = sumInvoiceTotals([{ ...creditLine, taxInclusive: false }]);
    expect(t.totalMinor).toBe(110_25);
    expect(t.taxTotalMinor).toBe(5_25);
  });
});
