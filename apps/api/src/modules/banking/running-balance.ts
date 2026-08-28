/**
 * The running balance down a bank account, in date order.
 *
 * Kept free of every other import so it can be tested directly. This is the
 * one calculation an edit or a deletion has to get right: a transaction's
 * running balance is not its own property, it is the account's balance as at
 * that point in the statement, so changing any amount moves every figure below
 * it.
 *
 * Ordered by date, then by insertion, which is what a bank statement means and
 * what makes a back-dated correction land in the right place. Before this the
 * balance was stamped from whatever the account happened to hold at the moment
 * the row was inserted, so anything entered out of order carried a figure that
 * did not match its position in the list.
 *
 * Excluded and duplicate rows still count, exactly as they did when they were
 * created. Dropping them here would silently restate the balance of every
 * account that has ever excluded anything, which is a separate decision from
 * being able to edit a transaction.
 */

export interface BalanceRow {
  id: string;
  /** Milliseconds. Compared numerically so equal dates fall back to insertion. */
  dateMs: number;
  /** Tiebreak within a day: earlier insertion first. */
  seq: number;
  amountMinor: number;
  runningBalanceMinor: number;
}

export interface BalanceResult {
  /** Only the rows whose stored balance is now wrong. */
  changed: { id: string; runningBalanceMinor: number }[];
  /** The account's balance once every transaction is applied. */
  closingBalanceMinor: number;
}

/** Date first, then insertion order, so the sequence is total and stable. */
export function compareRows(a: BalanceRow, b: BalanceRow): number {
  return a.dateMs - b.dateMs || a.seq - b.seq;
}

export function computeRunningBalances(
  openingBalanceMinor: number,
  rows: BalanceRow[],
): BalanceResult {
  const ordered = [...rows].sort(compareRows);

  let balance = openingBalanceMinor;
  const changed: { id: string; runningBalanceMinor: number }[] = [];

  for (const row of ordered) {
    balance += row.amountMinor;
    // Only what actually moved, so a correction near the end of a long history
    // writes a handful of rows rather than all of them.
    if (row.runningBalanceMinor !== balance) {
      changed.push({ id: row.id, runningBalanceMinor: balance });
    }
  }

  return { changed, closingBalanceMinor: balance };
}
