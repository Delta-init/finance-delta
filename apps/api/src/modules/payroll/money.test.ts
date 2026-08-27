import { describe, expect, it } from "bun:test";
import { toMinor, formatMinor, assertTotalsAgree } from "./money";

/**
 * The float-to-minor-unit boundary is the one place in the payroll integration
 * where money can quietly change value, so it gets its own tests.
 */
describe("toMinor", () => {
  it("converts ordinary amounts", () => {
    expect(toMinor(1234.56)).toBe(123456);
    expect(toMinor(0)).toBe(0);
    expect(toMinor(10)).toBe(1000);
  });

  it("survives the float values that normally break naive scaling", () => {
    // Each of these loses a fils under a plain Math.round(amount * 100):
    // 1.005 * 100 is 100.49999999999999, 8.615 * 100 is 861.4999999999999.
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor(1.005)).toBe(101);
    expect(toMinor(8.615)).toBe(862);
    expect(toMinor(1234.56)).toBe(123456);
    expect(toMinor(2.675)).toBe(268);
  });

  it("rounds a negative the same distance from zero as its positive twin", () => {
    expect(toMinor(-1.005)).toBe(-101);
    expect(toMinor(-8.615)).toBe(-862);
  });

  it("handles a negative amount, since a net can legitimately be one", () => {
    expect(toMinor(-45.5)).toBe(-4550);
  });

  it("refuses anything that is not a number rather than producing NaN minor units", () => {
    expect(() => toMinor(NaN)).toThrow(/not a number/);
    expect(() => toMinor(Infinity)).toThrow(/not a number/);
  });
});

describe("assertTotalsAgree", () => {
  it("passes when the parts add up to the whole", () => {
    expect(() => assertTotalsAgree("Net", 500_00, 500_00, "AED")).not.toThrow();
  });

  it("refuses a difference of a single fils", () => {
    // The whole point: a one-fils drift is exactly the kind of thing a system
    // would otherwise absorb, and it means one of the two sides is stale.
    expect(() => assertTotalsAgree("Net pay", 500_01, 500_00, "AED")).toThrow(/does not add up/);
  });

  it("says what the difference is, in money a person can read", () => {
    expect(() => assertTotalsAgree("Net pay", 1_000_00, 999_00, "AED")).toThrow(/AED 1.00/);
  });

  it("promises that nothing was imported", () => {
    expect(() => assertTotalsAgree("Net pay", 1, 2, "AED")).toThrow(/Nothing has been imported/);
  });
});

describe("formatMinor", () => {
  it("renders minor units as readable money", () => {
    expect(formatMinor(123456, "AED")).toBe("AED 1,234.56");
    expect(formatMinor(0, "INR")).toBe("INR 0.00");
  });
});
