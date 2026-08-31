import { describe, expect, test } from "bun:test";
import { computeExpenseTax } from "./index";

describe("computeExpenseTax", () => {
  test("exclusive adds the tax on top", () => {
    // 100.00 + 5% = 105.00
    expect(computeExpenseTax(10000, 5)).toEqual({ netMinor: 10000, taxMinor: 500, totalMinor: 10500 });
  });

  test("inclusive backs the tax out of what was typed", () => {
    // A receipt for 105.00 including 5% is 100.00 + 5.00.
    expect(computeExpenseTax(10500, 5, true)).toEqual({ netMinor: 10000, taxMinor: 500, totalMinor: 10500 });
  });

  test("net plus tax is always exactly the total", () => {
    // Rounding must never leave a claim a fil out from itself, which is why the
    // tax is a difference rather than a second calculation.
    for (let amount = 1; amount <= 3000; amount++) {
      for (const pct of [5, 9, 12, 18]) {
        for (const inclusive of [false, true]) {
          const r = computeExpenseTax(amount, pct, inclusive);
          expect(r.netMinor + r.taxMinor).toBe(r.totalMinor);
        }
      }
    }
  });

  test("inclusive of an 18% GST receipt", () => {
    // 1180.00 including 18% is 1000.00 + 180.00.
    expect(computeExpenseTax(118000, 18, true)).toEqual({
      netMinor: 100000, taxMinor: 18000, totalMinor: 118000,
    });
  });

  test("no tax rate leaves the figure alone either way", () => {
    expect(computeExpenseTax(7500, 0)).toEqual({ netMinor: 7500, taxMinor: 0, totalMinor: 7500 });
    expect(computeExpenseTax(7500, 0, true)).toEqual({ netMinor: 7500, taxMinor: 0, totalMinor: 7500 });
  });

  test("zero is not a special case", () => {
    expect(computeExpenseTax(0, 5, true)).toEqual({ netMinor: 0, taxMinor: 0, totalMinor: 0 });
  });

  test("a negative rate is treated as none rather than refunding tax", () => {
    expect(computeExpenseTax(10000, -5)).toEqual({ netMinor: 10000, taxMinor: 0, totalMinor: 10000 });
  });
});
