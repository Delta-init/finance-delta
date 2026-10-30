import { describe, expect, it } from "bun:test";
import { batchByCurrency, currencyOf, summariseByCurrency } from "./currency-totals";

const line = (currency: string | null, payable: number, gross = payable, paid = 0) => ({
  currency,
  grossMinor: gross,
  deductionsMinor: gross - payable,
  payableMinor: payable,
  amountPaidMinor: paid,
});

describe("summariseByCurrency", () => {
  it("keeps a single-currency run as one row", () => {
    const out = summariseByCurrency([line("AED", 1000), line("AED", 2000)], "AED");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ currency: "AED", employeeCount: 2, payableMinor: 3000 });
  });

  it("does not add unlike currencies together", () => {
    // The whole point. 77 dirham salaries and 22 rupee ones summed as one
    // figure is out by a factor of twenty-two on every rupee line.
    const out = summariseByCurrency(
      [line("AED", 500000), line("INR", 8000000), line("AED", 300000)],
      "AED",
    );
    expect(out).toHaveLength(2);
    const aed = out.find((r) => r.currency === "AED")!;
    const inr = out.find((r) => r.currency === "INR")!;
    expect(aed).toMatchObject({ employeeCount: 2, payableMinor: 800000 });
    expect(inr).toMatchObject({ employeeCount: 1, payableMinor: 8000000 });
  });

  it("leads with the run's own currency, not the bigger number", () => {
    // 9,000 rupees is a bigger number than 1 dirham and says nothing about which
    // is more money. Ordering by amount across currencies put October's rupees
    // ahead of a dirham payroll worth twelve times as much.
    const out = summariseByCurrency([line("AED", 100), line("INR", 900000)], "AED");
    expect(out.map((r) => r.currency)).toEqual(["AED", "INR"]);
  });

  it("when nobody is paid in the run's currency, the largest group of people leads", () => {
    const out = summariseByCurrency([line("USD", 10), line("INR", 5), line("INR", 5)], "AED");
    expect(out.map((r) => r.currency)).toEqual(["INR", "USD"]);
  });

  it("falls back to the run's currency for lines that predate the field", () => {
    // Rows imported before per-line currency existed carry none, and the run's
    // own is what was meant at the time.
    const out = summariseByCurrency([line(null, 1000), line("AED", 2000)], "AED");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ currency: "AED", employeeCount: 2, payableMinor: 3000 });
  });

  it("totals gross and deductions per currency too", () => {
    const out = summariseByCurrency(
      [line("AED", 800, 1000), line("INR", 5000, 6000)],
      "AED",
    );
    expect(out.find((r) => r.currency === "AED")).toMatchObject({ grossMinor: 1000, deductionsMinor: 200 });
    expect(out.find((r) => r.currency === "INR")).toMatchObject({ grossMinor: 6000, deductionsMinor: 1000 });
  });

  it("says what each currency's people are still owed", () => {
    // The dirhams paid and the rupees not: one outstanding figure for both
    // would read as a dirham debt the size of the rupee one.
    const out = summariseByCurrency(
      [line("AED", 1000, 1000, 1000), line("AED", 500, 500, 200), line("INR", 9000)],
      "AED",
    );
    expect(out.find((r) => r.currency === "AED")).toMatchObject({ amountPaidMinor: 1200, balanceMinor: 300 });
    expect(out.find((r) => r.currency === "INR")).toMatchObject({ amountPaidMinor: 0, balanceMinor: 9000 });
  });

  it("handles an empty run", () => {
    expect(summariseByCurrency([], "AED")).toEqual([]);
  });
});

/** `count` payslips in `currency` netting `totalMinor` between them. */
const slips = (currency: string, count: number, totalMinor: number) =>
  Array.from({ length: count }, (_, i) => ({
    currency, grossMinor: 0, deductionsMinor: 0, netMinor: i === 0 ? totalMinor - (count - 1) : 1,
  }));

describe("batchByCurrency", () => {
  it("splits a month the way October 2026 really was", () => {
    // 81 dirham payslips and 22 rupee ones, which the import screen showed as
    // one figure: AED 972,458.21.
    const out = batchByCurrency([...slips("INR", 22, 62_763_333), ...slips("AED", 81, 34_482_488)], "AED");
    expect(out).toEqual([
      { currency: "AED", employeeCount: 81, grossMinor: 0, deductionsMinor: 0, netMinor: 34_482_488 },
      { currency: "INR", employeeCount: 22, grossMinor: 0, deductionsMinor: 0, netMinor: 62_763_333 },
    ]);
  });

  it("reads a payslip with no currency as the batch's, and a sloppy code as what it means", () => {
    const out = batchByCurrency(
      [
        { currency: undefined, grossMinor: 100, deductionsMinor: 0, netMinor: 100 },
        { currency: " aed ", grossMinor: 50, deductionsMinor: 10, netMinor: 40 },
        { currency: "inr", grossMinor: 900, deductionsMinor: 0, netMinor: 900 },
      ],
      "AED",
    );
    expect(out).toEqual([
      { currency: "AED", employeeCount: 2, grossMinor: 150, deductionsMinor: 10, netMinor: 140 },
      { currency: "INR", employeeCount: 1, grossMinor: 900, deductionsMinor: 0, netMinor: 900 },
    ]);
  });

  it("leads an all-rupee month with its rupees", () => {
    const out = batchByCurrency(slips("INR", 1, 1), "AED");
    expect(out.map((r) => r.currency)).toEqual(["INR"]);
  });
});

describe("currencyOf", () => {
  it("trims and capitalises, and falls back to the run's", () => {
    expect(currencyOf(" inr ", "AED")).toBe("INR");
    expect(currencyOf("", "aed")).toBe("AED");
    expect(currencyOf(null, "")).toBe("AED");
  });
});
