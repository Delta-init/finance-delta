/**
 * Adding payroll up without adding unlike currencies together.
 *
 * Every payslip carries its own currency, and a month can hold salaries in
 * dirhams and salaries in rupees side by side: October 2026 held 81 of one and
 * 22 of the other. Summing them as plain numbers gives a figure that is not an
 * amount of anything. The import screen read "AED 972,458.21" when AED
 * 344,824.88 of it was dirhams and INR 627,633.33 was rupees. So a total here
 * is a list, one row per currency.
 *
 * Nothing is converted here: that needs a rate, and the screen applies today's,
 * marked as approximate. Kept free of imports, like `money.ts` and
 * `recalculate.ts`, so it can be tested on its own.
 */

const norm = (c: string | null | undefined) => (c ?? "").trim().toUpperCase();

/** A line's currency, or `fallback` (the run's) for a line imported before lines carried one. */
export function currencyOf(currency: string | null | undefined, fallback: string): string {
  return norm(currency) || norm(fallback) || "AED";
}

/**
 * The run's own currency first whenever anybody is paid in it, then the rest
 * by how many people they pay, then by code. That is the rule HRMS uses, so the
 * two systems list a month the same way, and it is fully determined, so the
 * same data never comes back in a different order.
 *
 * Not by amount. 627,633 rupees is a bigger number than 344,824 dirhams and a
 * far smaller sum of money; comparing amounts across currencies is the mistake
 * this module exists to stop.
 */
export function orderByHeadline<T extends { currency: string; employeeCount: number }>(rows: T[], headline: string): T[] {
  const lead = norm(headline);
  const rank = (r: T) => (lead && r.currency === lead ? 0 : 1);
  return [...rows].sort(
    (a, b) => rank(a) - rank(b) || b.employeeCount - a.employeeCount || a.currency.localeCompare(b.currency),
  );
}

export interface RunCurrencyTotals {
  currency: string;
  employeeCount: number;
  grossMinor: number;
  deductionsMinor: number;
  payableMinor: number;
  amountPaidMinor: number;
  /** Payable less paid: what this currency's people are still owed, held people included. */
  balanceMinor: number;
}

/** An imported run's lines, totalled per currency. */
export function summariseByCurrency(
  lines: { currency?: string | null; grossMinor: number; deductionsMinor: number; payableMinor: number; amountPaidMinor: number }[],
  runCurrency: string,
): RunCurrencyTotals[] {
  const acc = new Map<string, RunCurrencyTotals>();
  for (const l of lines) {
    const currency = currencyOf(l.currency, runCurrency);
    const row = acc.get(currency) ?? {
      currency, employeeCount: 0, grossMinor: 0, deductionsMinor: 0, payableMinor: 0, amountPaidMinor: 0, balanceMinor: 0,
    };
    row.employeeCount += 1;
    row.grossMinor += l.grossMinor;
    row.deductionsMinor += l.deductionsMinor;
    row.payableMinor += l.payableMinor;
    row.amountPaidMinor += l.amountPaidMinor;
    row.balanceMinor = row.payableMinor - row.amountPaidMinor;
    acc.set(currency, row);
  }
  return orderByHeadline([...acc.values()], runCurrency);
}

export interface BatchCurrencyTotals {
  currency: string;
  employeeCount: number;
  grossMinor: number;
  deductionsMinor: number;
  netMinor: number;
}

/** A month HRMS is offering, totalled per currency from its payslips (already in minor units). */
export function batchByCurrency(
  lines: { currency?: string | null; grossMinor: number; deductionsMinor: number; netMinor: number }[],
  batchCurrency: string,
): BatchCurrencyTotals[] {
  const acc = new Map<string, BatchCurrencyTotals>();
  for (const l of lines) {
    const currency = currencyOf(l.currency, batchCurrency);
    const row = acc.get(currency) ?? { currency, employeeCount: 0, grossMinor: 0, deductionsMinor: 0, netMinor: 0 };
    row.employeeCount += 1;
    row.grossMinor += l.grossMinor;
    row.deductionsMinor += l.deductionsMinor;
    row.netMinor += l.netMinor;
    acc.set(currency, row);
  }
  return orderByHeadline([...acc.values()], batchCurrency);
}
