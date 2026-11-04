import { describe, expect, it } from "bun:test";
import { payrollLineOf } from "./hrms-wallet.service";

const run = {
  runNumber: "PR-0007",
  status: "partially_paid",
  currency: "AED",
  lines: [
    { _id: "l1", hrmsEmployeeId: "e1", status: "partially_paid", payableMinor: 750_500, amountPaidMinor: 700_000 },
    { _id: "l2", hrmsEmployeeId: "e2", status: "paid", payableMinor: 400_000, amountPaidMinor: 400_000, currency: "INR" },
  ],
  adjustments: [
    { externalId: "x1", lineId: "l1", kind: "addition" as const, source: "crm_commission", label: "CRM commission — October 2026", amountMinor: 290_500 },
    { externalId: "x2", lineId: "l2", kind: "deduction" as const, source: "manual", label: "Fine", amountMinor: 5_000, recoveredMinor: 5_000 },
  ],
  payments: [
    { paymentId: "p2", method: "cash", paidOn: "2026-11-03T00:00:00Z", reference: "", allocations: [{ lineId: "l1", amountMinor: 200_000 }], finishedLineIds: [] },
    {
      paymentId: "p1", method: "bank_transfer", paidOn: "2026-11-02T00:00:00Z", reference: "FT1", bankAccountName: "ADCB",
      allocations: [{ lineId: "l1", amountMinor: 500_000 }, { lineId: "l2", amountMinor: 400_000 }], finishedLineIds: ["l2"],
    },
    { paymentId: "p0", method: "bank_transfer", paidOn: "2026-11-01T00:00:00Z", allocations: [{ lineId: "l1", amountMinor: 100_000 }], reversedAt: "2026-11-01T10:00:00Z", reversalReason: "Wrong account" },
    // Before part pay: no finishedLineIds — everybody in it was paid in full.
    { paymentId: "old", method: "cheque", paidOn: "2026-11-04T00:00:00Z", allocations: [{ lineId: "l2", amountMinor: 1 }] },
  ],
};

describe("payrollLineOf", () => {
  it("is null for somebody not on the run", () => {
    expect(payrollLineOf(run, "nobody")).toBeNull();
  });

  it("gives what is owed, paid and left, in major units", () => {
    const p = payrollLineOf(run, "e1")!;
    expect(p.payable).toBe(7505);
    expect(p.paid).toBe(7000);
    expect(p.balance).toBe(505);
    expect(p.currency).toBe("AED");
    expect(p.lineStatus).toBe("partially_paid");
  });

  it("keeps only this person's share of each payment, oldest first, reversals marked", () => {
    const p = payrollLineOf(run, "e1")!;
    expect(p.payments.map((x) => [x.paymentId, x.amount, x.reversed])).toEqual([
      ["p0", 1000, true], ["p1", 5000, false], ["p2", 2000, false],
    ]);
    expect(p.payments[1]!.account).toBe("ADCB");
    expect(p.payments[1]!.finished).toBe(false);
    expect(p.payments[0]!.reversalReason).toBe("Wrong account");
  });

  it("reads an old payment without a finished list as paying in full", () => {
    const p = payrollLineOf(run, "e2")!;
    expect(p.currency).toBe("INR");
    expect(p.payments.find((x) => x.paymentId === "old")!.finished).toBe(true);
    expect(p.payments.find((x) => x.paymentId === "p1")!.finished).toBe(true);
  });

  it("lists only this person's finance additions and deductions", () => {
    expect(payrollLineOf(run, "e1")!.adjustments).toEqual([
      { externalId: "x1", kind: "addition", source: "crm_commission", label: "CRM commission — October 2026", amount: 2905, recovered: 2905 },
    ]);
    expect(payrollLineOf(run, "e2")!.adjustments[0]!.recovered).toBe(50);
  });
});
