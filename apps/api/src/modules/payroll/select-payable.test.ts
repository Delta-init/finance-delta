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
