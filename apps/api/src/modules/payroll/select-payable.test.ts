import { describe, expect, it } from "bun:test";
import { selectPayableLines, isSettled, type PayableLine } from "./select-payable";

const line = (
  id: string,
  payable: number,
  paid = 0,
  status: PayableLine["status"] = "pending",
): PayableLine => ({ _id: id, status, payableMinor: payable, amountPaidMinor: paid });

describe("selectPayableLines", () => {
  it("pays everybody outstanding when no one is named", () => {
    const s = selectPayableLines([line("a", 500_00), line("b", 300_00)]);
    expect(s.allocations).toHaveLength(2);
    expect(s.amountMinor).toBe(800_00);
  });

  it("pays only the people named", () => {
    const s = selectPayableLines([line("a", 500_00), line("b", 300_00)], ["a"]);
    expect(s.allocations).toHaveLength(1);
    expect(s.amountMinor).toBe(500_00);
  });

  it("never sweeps a held person into a bulk payment", () => {
    // The important one. Somebody with no bank details cannot receive the
    // transfer, so marking them paid would be a lie no later step would catch.
    const s = selectPayableLines([line("a", 500_00), line("b", 300_00, 0, "on_hold")]);
    expect(s.allocations).toHaveLength(1);
    expect(s.amountMinor).toBe(500_00);
    expect(s.skipped.held).toBe(1);
  });

  it("still refuses a held person who was named explicitly", () => {
    const s = selectPayableLines([line("a", 300_00, 0, "on_hold")], ["a"]);
    expect(s.allocations).toHaveLength(0);
    expect(s.skipped.held).toBe(1);
  });

  it("skips somebody already paid", () => {
    const s = selectPayableLines([line("a", 500_00, 500_00, "paid"), line("b", 300_00)]);
    expect(s.amountMinor).toBe(300_00);
    expect(s.skipped.alreadyPaid).toBe(1);
  });

  it("pays only the remainder of a part-paid person", () => {
    const s = selectPayableLines([line("a", 500_00, 200_00, "partially_paid")]);
    expect(s.amountMinor).toBe(300_00);
  });

  it("skips a line whose payable has fallen below what was already paid", () => {
    // A late deduction can do this. Transferring a negative would quietly
    // reduce the total of the payment rather than raising the problem.
    const s = selectPayableLines([line("a", 100_00, 300_00, "partially_paid")]);
    expect(s.allocations).toHaveLength(0);
    expect(s.amountMinor).toBe(0);
  });

  it("reports ids that are not on this run", () => {
    const s = selectPayableLines([line("a", 500_00)], ["a", "ghost"]);
    expect(s.skipped.notFound).toBe(1);
    expect(s.allocations).toHaveLength(1);
  });

  it("returns nothing payable when everybody is held", () => {
    const s = selectPayableLines([line("a", 1_00, 0, "on_hold"), line("b", 2_00, 0, "on_hold")]);
    expect(s.amountMinor).toBe(0);
    expect(s.skipped.held).toBe(2);
  });

  it("adds up exactly, with no float drift across many lines", () => {
    const lines = Array.from({ length: 60 }, (_, i) => line(`e${i}`, 3_333_33));
    expect(selectPayableLines(lines).amountMinor).toBe(60 * 3_333_33);
  });
});

describe("selectPayableLines in one currency", () => {
  const paidIn = (currency: string | null, l: PayableLine): PayableLine => ({ ...l, currency });
  // A month like October 2026: dirham salaries and rupee salaries on one run.
  const month = [
    paidIn("AED", line("a1", 10_000_00)),
    paidIn("AED", line("a2", 5_000_00)),
    paidIn("INR", line("i1", 80_000_00)),
    paidIn(null, line("old", 1_000_00)), // imported before lines carried a currency: the run's
  ];

  it("never takes a rupee salary into a payment from a dirham account", () => {
    // The bug: "pay everybody" from the AED account took INR 80,000 out of it as
    // AED 80,000.
    const s = selectPayableLines(month, undefined, { currency: "AED", fallback: "AED" });
    expect(s.allocations.map((a) => a.lineId)).toEqual(["a1", "a2", "old"]);
    expect(s.amountMinor).toBe(16_000_00);
    expect(s.skipped.otherCurrency).toBe(1);
  });

  it("pays the rupee salaries from a rupee account, and only them", () => {
    const s = selectPayableLines(month, undefined, { currency: "INR", fallback: "AED" });
    expect(s.allocations.map((a) => a.lineId)).toEqual(["i1"]);
    expect(s.amountMinor).toBe(80_000_00);
    expect(s.skipped.otherCurrency).toBe(3);
  });

  it("drops a named person paid in another currency rather than paying them in this one", () => {
    const s = selectPayableLines(month, ["a1", "i1"], { currency: "AED", fallback: "AED" });
    expect(s.allocations.map((a) => a.lineId)).toEqual(["a1"]);
    expect(s.skipped.otherCurrency).toBe(1);
  });

  it("reads the account's currency as a code, however it is written", () => {
    const s = selectPayableLines(month, undefined, { currency: " inr ", fallback: "AED" });
    expect(s.allocations.map((a) => a.lineId)).toEqual(["i1"]);
  });

  it("counts a held person in this currency as held, and one in another as elsewhere", () => {
    const s = selectPayableLines(
      [paidIn("AED", line("h", 1_00, 0, "on_hold")), paidIn("INR", line("i", 2_00))],
      undefined,
      { currency: "AED", fallback: "AED" },
    );
    expect(s.allocations).toHaveLength(0);
    expect(s.skipped).toEqual({ held: 1, alreadyPaid: 0, notFound: 0, otherCurrency: 1 });
  });
});

/**
 * One person paid in parts (2026-11-03): part by bank transfer, the rest in cash, each its own payment naming how
 * much. The amount asked is what moves — never more than they are still owed.
 */
describe("selectPayableLines with amounts", () => {
  const amounts = (o: Record<string, number>) => new Map(Object.entries(o));

  it("pays the amount asked, not the whole remainder", () => {
    const s = selectPayableLines([line("a", 18_062_00), line("b", 300_00)], undefined, undefined, amounts({ a: 10_000_00 }));
    expect(s.allocations).toEqual([{ lineId: "a", amountMinor: 10_000_00 }]);
    expect(s.amountMinor).toBe(10_000_00);
    expect(s.over).toHaveLength(0);
  });

  it("pays the rest of somebody part paid", () => {
    const s = selectPayableLines([line("a", 18_062_00, 10_000_00, "partially_paid")], undefined, undefined, amounts({ a: 8_062_00 }));
    expect(s.amountMinor).toBe(8_062_00);
  });

  it("refuses more than somebody is still owed rather than cutting it down", () => {
    const s = selectPayableLines([line("a", 18_062_00, 10_000_00, "partially_paid"), line("b", 300_00)], undefined, undefined, amounts({ a: 9_000_00, b: 300_00 }));
    expect(s.over).toEqual([{ lineId: "a", askedMinor: 9_000_00, remainingMinor: 8_062_00 }]);
    expect(s.allocations.map((x) => x.lineId)).toEqual(["b"]);
  });

  it("still never pays a held person, nor one in another currency", () => {
    const s = selectPayableLines(
      [line("h", 500_00, 0, "on_hold"), { ...line("i", 2_00), currency: "INR" }],
      undefined,
      { currency: "AED", fallback: "AED" },
      amounts({ h: 100_00, i: 1_00 }),
    );
    expect(s.allocations).toHaveLength(0);
    expect(s.skipped).toEqual({ held: 1, alreadyPaid: 0, notFound: 0, otherCurrency: 1 });
  });
});

describe("isSettled", () => {
  it("treats a paid or held line as settled", () => {
    expect(isSettled(line("a", 500_00, 500_00, "paid"))).toBe(true);
    expect(isSettled(line("a", 500_00, 0, "on_hold"))).toBe(true);
  });

  it("treats somebody still owed money as unsettled", () => {
    expect(isSettled(line("a", 500_00))).toBe(false);
    expect(isSettled(line("a", 500_00, 200_00, "partially_paid"))).toBe(false);
  });

  /**
   * Somebody whose whole salary went to a recovery is owed nothing and will
   * never appear in a transfer. Counted as outstanding, they left the run stuck
   * at partially_paid for ever, waiting on a payment that could not be made.
   */
  it("treats a person owed nothing as settled", () => {
    expect(isSettled(line("a", 0, 0))).toBe(true);
    expect(isSettled(line("a", 100_00, 300_00, "partially_paid"))).toBe(true);
  });
});
