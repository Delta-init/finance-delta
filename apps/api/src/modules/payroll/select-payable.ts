/**
 * Which people a transfer should actually cover, and for how much.
 *
 * Pulled out of `payRun` and kept free of config, databases and HTTP (its one
 * import is as pure as it is) so it can be tested directly.
 * This is the decision that immediately precedes money leaving a bank account,
 * and every one of its rules exists because the alternative marks somebody paid
 * who was not.
 */

import { currencyOf } from "./currency-totals";

export interface PayableLine {
  _id: unknown;
  status: "pending" | "on_hold" | "partially_paid" | "paid";
  payableMinor: number;
  amountPaidMinor: number;
  /** What this person is paid in. Absent on lines imported before lines carried it. */
  currency?: string | null;
}

export interface Allocation {
  lineId: unknown;
  amountMinor: number;
}

export interface Selection {
  allocations: Allocation[];
  amountMinor: number;
  /** Named by the caller but not payable, so the UI can say why nothing happened. */
  skipped: { held: number; alreadyPaid: number; notFound: number; otherCurrency: number };
}

/**
 * `lineIds` empty or absent means "everybody still owed".
 *
 * Held people are excluded even then. There is nowhere to send their money, so
 * including them in a bulk transfer would mark them paid on the strength of a
 * payment that could not have reached them — and that error is invisible
 * afterwards, because the payslip would say paid.
 *
 * Each allocation is the remainder, not the full payable: a line already part
 * paid must not be paid its whole amount a second time.
 *
 * `only` keeps a payment to the people paid in one currency (a line without one
 * counts as `fallback`, the run's). A bank account pays out in one currency,
 * and a month can hold salaries in dirhams and in rupees: counting a rupee
 * salary into a payment from a dirham account takes the rupee figure out of the
 * account as dirhams, which is what happened before this existed.
 */
export function selectPayableLines(
  lines: PayableLine[],
  lineIds?: string[],
  only?: { currency: string; fallback: string },
): Selection {
  const wanted = lineIds?.length ? new Set(lineIds) : null;
  const skipped = { held: 0, alreadyPaid: 0, notFound: 0, otherCurrency: 0 };
  const currency = only ? currencyOf(only.currency, only.fallback) : null;

  if (wanted) {
    const present = new Set(lines.map((l) => String(l._id)));
    for (const id of wanted) if (!present.has(id)) skipped.notFound++;
  }

  const allocations: Allocation[] = [];
  for (const line of lines) {
    if (wanted && !wanted.has(String(line._id))) continue;

    // Not part of this payment at all, so counted apart from the held and the paid.
    if (only && currencyOf(line.currency, only.fallback) !== currency) { skipped.otherCurrency++; continue; }

    if (line.status === "on_hold") { skipped.held++; continue; }
    if (line.status === "paid") { skipped.alreadyPaid++; continue; }

    const remaining = line.payableMinor - line.amountPaidMinor;
    // A non-positive remainder covers both the fully-paid case and the odd one
    // where a deduction landed after a payment: neither is something to
    // transfer, and a negative would silently reduce the total.
    if (remaining <= 0) { skipped.alreadyPaid++; continue; }

    allocations.push({ lineId: line._id, amountMinor: remaining });
  }

  return {
    allocations,
    amountMinor: allocations.reduce((a, x) => a + x.amountMinor, 0),
    skipped,
  };
}

/**
 * Is there anything left to do for this person?
 *
 * A line whose payable has been consumed entirely — somebody whose whole salary
 * went to an advance recovery — is owed nothing and will never appear in a
 * transfer. Counting it as outstanding leaves the run stuck at partially_paid
 * for ever, waiting on a payment that can never be made.
 */
export function isSettled(line: PayableLine): boolean {
  if (line.status === "paid" || line.status === "on_hold") return true;
  return line.payableMinor - line.amountPaidMinor <= 0;
}
