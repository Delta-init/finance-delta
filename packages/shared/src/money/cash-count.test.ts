import { describe, expect, test } from "bun:test";
import { compareCashCount } from "./index";

describe("compareCashCount", () => {
  test("more cash than the book expected is over, and credits the book", () => {
    const r = compareCashCount(20_100_00, 20_000_00);
    expect(r.verdict).toBe("over");
    expect(r.adjustmentMinor).toBe(100_00);
  });

  test("less cash than the book expected is short, and debits it", () => {
    const r = compareCashCount(19_900_00, 20_000_00);
    expect(r.verdict).toBe("short");
    expect(r.adjustmentMinor).toBe(-100_00);
  });

  test("agreeing posts nothing", () => {
    const r = compareCashCount(20_000_00, 20_000_00);
    expect(r.verdict).toBe("agrees");
    expect(r.adjustmentMinor).toBe(0);
  });

  test("the adjustment always brings the book to the count", () => {
    // The whole point: after posting it, the book equals the cash. A sign the
    // wrong way round would move the balance further from the truth.
    for (const book of [0, 1, 55, 18_382_75, 20_000_00]) {
      for (const counted of [0, 1, 54, 18_382_75, 20_685_75]) {
        const { adjustmentMinor } = compareCashCount(counted, book);
        expect(book + adjustmentMinor).toBe(counted);
      }
    }
  });

  test("an empty tin counted empty agrees rather than reading as short", () => {
    expect(compareCashCount(0, 0).verdict).toBe("agrees");
  });
});
