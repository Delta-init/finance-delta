import { describe, expect, it } from "bun:test";
import { computeRunningBalances, compareRows, type BalanceRow } from "./running-balance";

const day = (d: number) => Date.UTC(2026, 2, d);

const row = (id: string, d: number, amountMinor: number, stored = 0, seq = 0): BalanceRow => ({
  id, dateMs: day(d), seq, amountMinor, runningBalanceMinor: stored,
});

describe("computeRunningBalances", () => {
  it("runs the balance down the statement in date order", () => {
    const { changed, closingBalanceMinor } = computeRunningBalances(1_000_00, [
      row("a", 1, 500_00),
      row("b", 2, -200_00),
      row("c", 3, 100_00),
    ]);
    expect(changed.map((c) => c.runningBalanceMinor)).toEqual([1_500_00, 1_300_00, 1_400_00]);
    expect(closingBalanceMinor).toBe(1_400_00);
  });

  it("puts a back-dated entry where its date says, not where it was typed", () => {
    // The whole reason for ordering by date: this row was entered last but
    // belongs first, and everything after it has to shift.
    const { changed } = computeRunningBalances(0, [
      row("later", 10, 100_00),
      row("backdated", 1, 50_00),
    ]);
    expect(changed).toEqual([
      { id: "backdated", runningBalanceMinor: 50_00 },
      { id: "later", runningBalanceMinor: 150_00 },
    ]);
  });

  it("breaks a tie on the same day by insertion order", () => {
    const { changed } = computeRunningBalances(0, [
      row("second", 5, 20_00, 0, 2),
      row("first", 5, 10_00, 0, 1),
    ]);
    expect(changed.map((c) => c.id)).toEqual(["first", "second"]);
    expect(changed.map((c) => c.runningBalanceMinor)).toEqual([10_00, 30_00]);
  });

  it("starts from the opening balance, not from zero", () => {
    const { closingBalanceMinor } = computeRunningBalances(250_00, [row("a", 1, 100_00)]);
    expect(closingBalanceMinor).toBe(350_00);
  });

  it("reports only the rows whose stored balance is now wrong", () => {
    // A correction late in a long history should not rewrite everything above it.
    const { changed } = computeRunningBalances(0, [
      row("a", 1, 100_00, 100_00),
      row("b", 2, 100_00, 200_00),
      row("c", 3, 100_00, 999_99),
    ]);
    expect(changed).toEqual([{ id: "c", runningBalanceMinor: 300_00 }]);
  });

  it("reports nothing when every stored balance is already right", () => {
    const { changed } = computeRunningBalances(0, [
      row("a", 1, 100_00, 100_00),
      row("b", 2, -40_00, 60_00),
    ]);
    expect(changed).toEqual([]);
  });

  it("handles an account with no transactions", () => {
    const { changed, closingBalanceMinor } = computeRunningBalances(500_00, []);
    expect(changed).toEqual([]);
    expect(closingBalanceMinor).toBe(500_00);
  });

  it("carries an overdrawn balance rather than flooring it at zero", () => {
    const { closingBalanceMinor } = computeRunningBalances(100_00, [row("a", 1, -300_00)]);
    expect(closingBalanceMinor).toBe(-200_00);
  });

  it("leaves the caller's array untouched", () => {
    const rows = [row("later", 10, 100_00), row("backdated", 1, 50_00)];
    computeRunningBalances(0, rows);
    expect(rows.map((r) => r.id)).toEqual(["later", "backdated"]);
  });

  it("is idempotent — a second pass finds nothing to change", () => {
    const rows = [row("a", 1, 100_00), row("b", 2, 50_00)];
    const first = computeRunningBalances(0, rows);
    for (const c of first.changed) {
      rows.find((r) => r.id === c.id)!.runningBalanceMinor = c.runningBalanceMinor;
    }
    expect(computeRunningBalances(0, rows).changed).toEqual([]);
  });
});

describe("compareRows", () => {
  it("orders by date before insertion", () => {
    expect(compareRows(row("a", 1, 0, 0, 99), row("b", 2, 0, 0, 1))).toBeLessThan(0);
  });

  it("falls back to insertion within the same day", () => {
    expect(compareRows(row("a", 1, 0, 0, 1), row("b", 1, 0, 0, 2))).toBeLessThan(0);
  });
});
