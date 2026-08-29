import { describe, expect, it } from "bun:test";
import { summariseByCurrency } from "./payroll.service";

const line = (currency: string | null, payable: number, gross = payable) => ({
  currency,
  grossMinor: gross,
  deductionsMinor: gross - payable,
  payableMinor: payable,
  amountPaidMinor: 0,
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

  it("leads with the currency most of the payroll is in", () => {
    const out = summariseByCurrency([line("AED", 100), line("INR", 900000)], "AED");
    expect(out[0]!.currency).toBe("INR");
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

  it("handles an empty run", () => {
    expect(summariseByCurrency([], "AED")).toEqual([]);
  });
});
