import { describe, expect, test } from "bun:test";
import { toBaseMinor, fromBaseMinor } from "./index";

describe("toBaseMinor", () => {
  test("converts a foreign amount back to the organization's currency", () => {
    // An AED organization invoicing 1,200.00 USD at 1 AED = 0.2723 USD.
    // 1200 / 0.2723 ≈ 4,406.9 dirhams — not 327, which is what multiplying gives.
    expect(toBaseMinor(120_000, 0.2723)).toBe(440_690);
  });

  test("a rate of 1 leaves the figure alone", () => {
    expect(toBaseMinor(120_000, 1)).toBe(120_000);
  });

  test("an INR organization invoicing in dirhams", () => {
    // 1 INR = 0.0435 AED, so an AED 1,000.00 invoice is about 22,988.51 rupees.
    expect(toBaseMinor(100_000, 0.0435)).toBe(2_298_851);
  });

  test("a nonsense rate is refused rather than turned into a wrong figure", () => {
    // Better to leave the amount as it stands than to divide by zero or by a
    // rate somebody typed a minus sign into.
    expect(toBaseMinor(120_000, 0)).toBe(120_000);
    expect(toBaseMinor(120_000, -2)).toBe(120_000);
    expect(toBaseMinor(120_000, NaN)).toBe(120_000);
    expect(toBaseMinor(120_000, Infinity)).toBe(120_000);
  });

  test("zero is zero at any rate", () => {
    expect(toBaseMinor(0, 0.2723)).toBe(0);
  });
});

describe("fromBaseMinor", () => {
  test("is the other direction", () => {
    expect(fromBaseMinor(440_690, 0.2723)).toBe(120_000);
  });

  test("round trips to within the resolution the rate allows", () => {
    /*
     * Not to within a single minor unit, and it would be wrong to claim so.
     * Converting to the base currency rounds to a whole base minor unit, so at
     * a rate of 22.5 each base unit is worth 22.5 of the original — 999 becomes
     * 44 and comes back as 990. The loss is bounded by the rate, and that bound
     * is the honest thing to assert.
     */
    for (const rate of [0.2723, 3.6725, 0.0435, 1, 22.5]) {
      for (const amount of [1, 999, 120_000, 1_000_000]) {
        const back = fromBaseMinor(toBaseMinor(amount, rate), rate);
        expect(Math.abs(back - amount)).toBeLessThanOrEqual(Math.max(1, Math.ceil(rate)));
      }
    }
  });
});
