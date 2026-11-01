import { describe, expect, it } from "bun:test";
import { isAttendance, slabDifference } from "./slab";

// Minor units throughout: 3,000.00 is 300_000.
describe("putting somebody on their CRM salary slab", () => {
  it("a slab above the contract, half a day off: Basic 4,000 and the day priced off it", () => {
    // Contract 3,000, 0.5 day off cost 50; on a 4,000 slab the half day costs 66.67 — net 3,933.33.
    const r = slabDifference({ monthly: 300_000, paid: 300_000, slab: 400_000, attendance: [5_000] });
    expect(r).toEqual({ onSlip: 400_000, hrAttendance: 5_000, slabAttendance: 6_667, difference: 98_333 });
    expect(300_000 - 5_000 + r.difference).toBe(393_333);
  });

  it("a slab below the contract is a deduction, the days off cheaper with it", () => {
    // Contract 3,500, 1.5 days off cost 175; on a 2,000 slab they cost 100 — net 1,900.
    const r = slabDifference({ monthly: 350_000, paid: 350_000, slab: 200_000, attendance: [17_500] });
    expect(r.difference).toBe(-142_500);
    expect(350_000 - 17_500 + r.difference).toBe(190_000);
  });

  it("a part month keeps its share of the slab", () => {
    // Joined mid-month: the sheet paid 1,100 of a 3,000 contract, 2 days off cost 200. A 2,000 slab → 733.33, 133.33 off.
    const r = slabDifference({ monthly: 300_000, paid: 110_000, slab: 200_000, attendance: [20_000] });
    expect(r.onSlip).toBe(73_333);
    expect(r.slabAttendance).toBe(13_333);
    expect(110_000 - 20_000 + r.difference).toBe(73_333 - 13_333);
  });

  it("each attendance line priced off the slab, never more than the slab paid", () => {
    const r = slabDifference({ monthly: 300_000, paid: 300_000, slab: 600_000, attendance: [10_000, 2_500] });
    expect(r.slabAttendance).toBe(25_000);
    const capped = slabDifference({ monthly: 300_000, paid: 30_000, slab: 300_000, attendance: [300_000] });
    expect(capped.slabAttendance).toBe(capped.onSlip);
  });

  it("no difference when the slab is the contract; a payslip paying more than the contract counts as a whole month", () => {
    expect(slabDifference({ monthly: 300_000, paid: 300_000, slab: 300_000, attendance: [5_000] }).difference).toBe(0);
    expect(slabDifference({ monthly: 300_000, paid: 320_000, slab: 400_000, attendance: [] }).onSlip).toBe(400_000);
  });

  it("knows the attendance lines by HRMS's labels, nothing else", () => {
    expect(["Loss of Pay (0.5d)", "Late Penalty (1d)", "Early-Out Penalty (2d)"].every(isAttendance)).toBe(true);
    expect(["Advance recovery", "Loan EMI", "Pension"].some(isAttendance)).toBe(false);
  });
});
