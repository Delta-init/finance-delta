import { describe, expect, it } from "bun:test";
import { computeInvoiceLine, sumInvoiceTotals } from "./index";

/**
 * A course price is what the client pays.
 *
 * Enrolments are sold at the price on the brochure. A counsellor who agrees
 * 1,300 with a client has agreed 1,300 — so the enrolment form and the CRM
 * handover both price tax-inclusive, and the VAT comes out of that figure
 * rather than being added to it. Both routes must land on the same number, or
 * the same course bills differently depending on the screen it came through.
 */
const VAT5 = [{ code: "VAT", rate: 5 }];
const COURSE = { quantity: 1, unitPriceMinor: 1_300_00, taxes: VAT5, taxInclusive: true };

describe("enrolment pricing", () => {
  it("bills the agreed price, not the agreed price plus tax", () => {
    expect(computeInvoiceLine(COURSE).lineTotalMinor).toBe(1_300_00);
  });

  it("still charges the tax, taken out of the agreed price", () => {
    expect(computeInvoiceLine(COURSE).taxTotalMinor).toBeGreaterThan(0);
  });

  /**
   * 1,300 at 5% does not divide evenly: the net is 1,238.095…, so the parts
   * have to be reconciled rather than each rounded on its own. `taxableMinor`
   * rounds to 1,238.10 and the tax on that to 61.91, which would put the parts
   * a fil above the total — `sumInvoiceTotals` takes the subtotal as total less
   * tax for exactly this reason, and the form on screen does the same.
   */
  it("keeps the three figures on screen adding up", () => {
    const t = sumInvoiceTotals([COURSE]);
    expect(t.totalMinor).toBe(1_300_00);
    expect(t.subtotalMinor + t.taxTotalMinor).toBe(t.totalMinor);
  });

  it("charges the whole price as net when the organization has no tax", () => {
    const b = computeInvoiceLine({ quantity: 1, unitPriceMinor: 1_300_00, taxes: [], taxInclusive: true });
    expect(b.lineTotalMinor).toBe(1_300_00);
    expect(b.taxTotalMinor).toBe(0);
  });

  // What the old behaviour did, kept as the contrast: the client was quoted
  // 1,300 and invoiced 1,365.
  it("is not what pricing tax-exclusive would have billed", () => {
    expect(computeInvoiceLine({ ...COURSE, taxInclusive: false }).lineTotalMinor).toBe(1_365_00);
  });
});
