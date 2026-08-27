import { describe, expect, it } from "bun:test";
import { recalculate } from "./recalculate";

/**
 * The signed arithmetic behind a payroll line.
 *
 * Additions and deductions are both stored as positive amounts, so the sign
 * lives entirely in `recalculate` — which makes it exactly the place a payroll
 * would quietly gain or lose money. It touches no database, so it is tested on
 * its own with plain objects shaped like the subdocuments.
 *
 * The subtle one is that a deduction contributes `recoveredMinor`, not
 * `amountMinor`: HRMS only takes what a month can afford, and a run that
 * subtracted the full asking amount would show a payable lower than what is
 * actually going to be transferred.
 */
type Line = { _id: string; netFromHrmsMinor: number; adjustmentsMinor: number; payableMinor: number };
type Adj = { lineId: string; kind: "addition" | "deduction"; amountMinor: number; recoveredMinor: number };
type Run = {
  status: string; lines: Line[]; adjustments: Adj[];
  adjustmentsMinor: number; payableMinor: number; amountPaidMinor: number; balanceMinor: number;
};

const line = (id: string, net: number): Line => ({
  _id: id, netFromHrmsMinor: net, adjustmentsMinor: 0, payableMinor: net,
});

const run = (lines: Line[], adjustments: Adj[] = [], over: Partial<Run> = {}): Run => ({
  status: "imported", lines, adjustments,
  adjustmentsMinor: 0, payableMinor: 0, amountPaidMinor: 0, balanceMinor: 0,
  ...over,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const calc = (r: Run) => { recalculate(r as any); return r; };

describe("recalculate", () => {
  it("leaves a run with no adjustments exactly as HRMS sent it", () => {
    const r = calc(run([line("a", 500_00), line("b", 300_00)]));
    expect(r.payableMinor).toBe(800_00);
    expect(r.adjustmentsMinor).toBe(0);
    expect(r.lines[0]!.payableMinor).toBe(500_00);
  });

  it("raises the payable by an addition", () => {
    const r = calc(run([line("a", 500_00)], [
      { lineId: "a", kind: "addition", amountMinor: 100_00, recoveredMinor: 100_00 },
    ]));
    expect(r.lines[0]!.payableMinor).toBe(600_00);
    expect(r.payableMinor).toBe(600_00);
    expect(r.adjustmentsMinor).toBe(100_00);
  });

  it("lowers the payable by a deduction that was fully recovered", () => {
    const r = calc(run([line("a", 500_00)], [
      { lineId: "a", kind: "deduction", amountMinor: 200_00, recoveredMinor: 200_00 },
    ]));
    expect(r.lines[0]!.payableMinor).toBe(300_00);
  });

  it("subtracts only what was actually recovered, not what was asked for", () => {
    // The heart of it: a 2,000 deduction against 1,400 of take-home recovers
    // 1,400. Subtracting the full 2,000 would show a payable of -600 and have
    // the run transfer a different figure from the payslip.
    const r = calc(run([line("a", 1_400_00)], [
      { lineId: "a", kind: "deduction", amountMinor: 2_000_00, recoveredMinor: 1_400_00 },
    ]));
    expect(r.lines[0]!.payableMinor).toBe(0);
    expect(r.payableMinor).toBe(0);
  });

  it("never lets an unrecovered deduction push a payable negative", () => {
    const r = calc(run([line("a", 100_00)], [
      { lineId: "a", kind: "deduction", amountMinor: 900_00, recoveredMinor: 100_00 },
    ]));
    expect(r.lines[0]!.payableMinor).toBe(0);
  });

  it("combines several adjustments on one person", () => {
    const r = calc(run([line("a", 500_00)], [
      { lineId: "a", kind: "addition", amountMinor: 150_00, recoveredMinor: 150_00 },
      { lineId: "a", kind: "addition", amountMinor: 50_00, recoveredMinor: 50_00 },
      { lineId: "a", kind: "deduction", amountMinor: 75_00, recoveredMinor: 75_00 },
    ]));
    expect(r.lines[0]!.adjustmentsMinor).toBe(125_00);
    expect(r.lines[0]!.payableMinor).toBe(625_00);
  });

  it("keeps one person's adjustments off another person's line", () => {
    const r = calc(run([line("a", 500_00), line("b", 500_00)], [
      { lineId: "a", kind: "addition", amountMinor: 100_00, recoveredMinor: 100_00 },
    ]));
    expect(r.lines[0]!.payableMinor).toBe(600_00);
    expect(r.lines[1]!.payableMinor).toBe(500_00);
    expect(r.payableMinor).toBe(1_100_00);
  });

  it("recomputes the outstanding balance against what has been paid", () => {
    const r = calc(run([line("a", 500_00)], [], { amountPaidMinor: 200_00 }));
    expect(r.balanceMinor).toBe(300_00);
  });

  it("moves a run from imported to additions once something is on it", () => {
    const r = calc(run([line("a", 500_00)], [
      { lineId: "a", kind: "addition", amountMinor: 1_00, recoveredMinor: 1_00 },
    ]));
    expect(r.status).toBe("additions");
  });

  it("does not drag an approved run backwards into additions", () => {
    const r = calc(run([line("a", 500_00)], [
      { lineId: "a", kind: "addition", amountMinor: 1_00, recoveredMinor: 1_00 },
    ], { status: "approved" }));
    expect(r.status).toBe("approved");
  });

  it("is idempotent — recalculating twice gives the same answer", () => {
    // It reassigns rather than accumulates, so a second call after a partial
    // failure must not double anything.
    const r = run([line("a", 500_00)], [
      { lineId: "a", kind: "addition", amountMinor: 100_00, recoveredMinor: 100_00 },
    ]);
    calc(r);
    const first = r.payableMinor;
    calc(r);
    expect(r.payableMinor).toBe(first);
  });
});
