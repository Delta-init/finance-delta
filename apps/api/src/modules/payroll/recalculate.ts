/**
 * The signed arithmetic behind a payroll line.
 *
 * Additions and deductions are both stored as positive amounts, so the sign
 * lives here and nowhere else — which makes this the one place a payroll could
 * quietly gain or lose money. Kept free of every other import, like `money.ts`
 * and `signing.ts`, so it can be tested without dragging in config, a database
 * or an HTTP client.
 *
 * Deliberately structural rather than typed against the Mongoose document: it
 * needs three fields off a line and three off an adjustment, and asking for the
 * whole document would make it untestable for no benefit.
 */

export interface RecalcLine {
  _id: unknown;
  netFromHrmsMinor: number;
  adjustmentsMinor: number;
  payableMinor: number;
}

export interface RecalcAdjustment {
  lineId: unknown;
  kind: "addition" | "deduction";
  amountMinor: number;
  /** What HRMS actually took. Below `amountMinor` when the month could not afford it. */
  recoveredMinor: number;
}

export interface RecalcRun {
  status: string;
  lines: RecalcLine[];
  adjustments: RecalcAdjustment[];
  adjustmentsMinor: number;
  payableMinor: number;
  amountPaidMinor: number;
  balanceMinor: number;
}

/**
 * Re-derive every line's payable, and the run's totals, from its adjustments.
 *
 * A deduction contributes `recoveredMinor`, never `amountMinor`. HRMS only
 * recovers what a month can afford, so a 2,000 deduction against 1,400 of
 * take-home takes 1,400 and carries 600 forward — and a run that subtracted the
 * full asking amount would show a payable that is not the figure anybody is
 * going to transfer.
 *
 * Reassigns rather than accumulates, so calling it twice is safe. That matters:
 * a write-back that fails halfway is re-run, not unwound.
 */
export function recalculate(run: RecalcRun): void {
  for (const line of run.lines) {
    const mine = run.adjustments.filter((a) => String(a.lineId) === String(line._id));
    const net = mine.reduce(
      (a, adj) => a + (adj.kind === "addition" ? adj.amountMinor : -adj.recoveredMinor),
      0,
    );
    line.adjustmentsMinor = net;
    line.payableMinor = line.netFromHrmsMinor + net;
  }
  run.adjustmentsMinor = run.lines.reduce((a, l) => a + l.adjustmentsMinor, 0);
  run.payableMinor = run.lines.reduce((a, l) => a + l.payableMinor, 0);
  run.balanceMinor = run.payableMinor - run.amountPaidMinor;

  // Only ever forwards. A run that accounts have already approved must not be
  // dragged back into the editing state by a late recalculation.
  if (run.status === "imported" && run.adjustments.length > 0) run.status = "additions";
}
