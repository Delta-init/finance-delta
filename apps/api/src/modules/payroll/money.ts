import { AppError } from "../../lib/http";

/**
 * The boundary between how HRMS counts money and how this codebase does.
 *
 * HRMS stores pay as a two-decimal float; everything here is integer minor
 * units. The conversion is trivial and the danger is not the conversion — it
 * is that a float sum and a rounded-integer sum disagree by a fils or two, and
 * a payroll that silently absorbs that difference is a payroll where somebody
 * is paid a number nobody authorised.
 *
 * So converting is one function, and checking is another, and the checking one
 * throws rather than adjusts.
 */

/**
 * 1234.56 → 123456. Rounds half away from zero, as money is normally rounded.
 *
 * The `toFixed(6)` is not decoration. `1.005 * 100` evaluates to
 * 100.49999999999999 in IEEE 754, so a naive `Math.round` returns 100 and the
 * employee quietly loses a fils; `8.615 * 100` is 861.4999999999999 and loses
 * one the same way. Scaling first, then discarding the representation noise
 * below six decimal places, then rounding, gives the answer a person doing the
 * sum on paper would get.
 *
 * `Math.round` alone would also round -0.5 towards zero, so the sign is handled
 * explicitly — a negative net is unusual but legal, and it must not round in a
 * different direction from a positive one.
 */
export function toMinor(amount: number): number {
  if (!Number.isFinite(amount)) {
    throw new AppError("VALIDATION_ERROR", `HRMS sent an amount that is not a number: ${amount}`);
  }
  const scaled = Number((amount * 100).toFixed(6));
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
}

/** 123456 → "1,234.56", for messages a person will read. */
export function formatMinor(minor: number, currency: string): string {
  const value = minor / 100;
  return `${currency} ${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Refuses an import whose parts do not add up to its whole.
 *
 * Called with the per-line figures and the total HRMS reported for the same
 * month. A mismatch means one of the two is stale — most likely a payslip
 * changed after the batch snapshot was taken — and importing either number
 * would be importing a figure nobody agreed to.
 */
export function assertTotalsAgree(
  label: string,
  fromLines: number,
  reported: number,
  currency: string,
): void {
  if (fromLines === reported) return;
  const diff = fromLines - reported;
  throw new AppError(
    "CONFLICT",
    `${label} does not add up: the payslips total ${formatMinor(fromLines, currency)} but HRMS reports ` +
      `${formatMinor(reported, currency)}, a difference of ${formatMinor(Math.abs(diff), currency)}. ` +
      `Nothing has been imported. Ask HR to re-submit the month so both sides agree.`,
  );
}
