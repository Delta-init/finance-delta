/**
 * Money utilities. All amounts are integer **minor units** (e.g. fils/cents).
 * Never use floats to store money — only for transient % math, then round.
 */

export interface LineInput {
  quantity: number;
  unitPriceMinor: number;
  discountPct?: number; // 0–100
  taxPct?: number; // 0–100
}

export interface LineBreakdown {
  lineSubtotalMinor: number; // quantity × unit price
  discountMinor: number;
  taxableMinor: number; // subtotal − discount
  taxMinor: number;
  lineTotalMinor: number; // taxable + tax
}

export interface Totals {
  subtotalMinor: number;
  discountTotalMinor: number;
  taxTotalMinor: number;
  totalMinor: number;
}

export function computeLine(input: LineInput): LineBreakdown {
  const discountPct = input.discountPct ?? 0;
  const taxPct = input.taxPct ?? 0;
  const lineSubtotalMinor = Math.round(input.quantity * input.unitPriceMinor);
  const discountMinor = Math.round((lineSubtotalMinor * discountPct) / 100);
  const taxableMinor = lineSubtotalMinor - discountMinor;
  const taxMinor = Math.round((taxableMinor * taxPct) / 100);
  return {
    lineSubtotalMinor,
    discountMinor,
    taxableMinor,
    taxMinor,
    lineTotalMinor: taxableMinor + taxMinor,
  };
}

export function sumTotals(lines: LineInput[]): Totals {
  return lines.reduce<Totals>(
    (acc, line) => {
      const b = computeLine(line);
      acc.subtotalMinor += b.lineSubtotalMinor;
      acc.discountTotalMinor += b.discountMinor;
      acc.taxTotalMinor += b.taxMinor;
      acc.totalMinor += b.lineTotalMinor;
      return acc;
    },
    { subtotalMinor: 0, discountTotalMinor: 0, taxTotalMinor: 0, totalMinor: 0 },
  );
}

/** Format minor units for display, e.g. formatMoney(105050, "AED") → "AED 1,050.50". */
export function formatMoney(minor: number, currency = "AED"): string {
  const major = minor / 100;
  return `${currency} ${major.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Parse a major-unit string/number (e.g. "10.50") into minor units (1050).
 *
 * Built from the digits rather than by multiplying: `1.005 * 100` is
 * 100.49999999999999 in binary floating point, so rounding it gives 100 where
 * the answer is 101. Every amount anybody types into this application comes
 * through here, so that fil went missing in invoices, bills, expenses and
 * payroll adjustments alike.
 *
 * More than two decimal places is rounded, half away from zero — the same
 * direction `Math.round` takes for positives, and the direction the arithmetic
 * above was reaching for.
 */
export function toMinor(major: number | string): number {
  const raw = typeof major === "string" ? major.trim() : String(major);
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(raw);

  // Exponential notation, blank, or anything else non-numeric: fall back to
  // the float path so the old behaviour is kept rather than returning nothing.
  if (!m) {
    const n = typeof major === "string" ? parseFloat(major) : major;
    return Math.round((Number.isFinite(n) ? n : 0) * 100);
  }

  const [, sign, whole = "", frac = ""] = m;
  if (!whole && !frac) return 0;

  const cents = Number(frac.slice(0, 2).padEnd(2, "0") || "0");
  // A third decimal place decides whether the second rounds up.
  const carry = frac.length > 2 && Number(frac[2]) >= 5 ? 1 : 0;
  const minor = Number(whole || "0") * 100 + cents + carry;
  return sign === "-" ? -minor : minor;
}

// ── Multi-tax invoice line computation ──────────────────────────────────────

export interface TaxRateInput {
  code: string;
  rate: number; // 0–100
}

export interface TaxRateResult extends TaxRateInput {
  amountMinor: number;
}

export interface InvoiceLineCalcInput {
  quantity: number;
  unitPriceMinor: number;
  discountPct?: number;
  taxes?: TaxRateInput[];
  /**
   * A single rate, for lines that predate per-code taxes or never needed them.
   *
   * Used only when `taxes` is empty. Credit notes still describe a line this
   * way, and until this was honoured they were taxed at zero however the rate
   * was set — the exclusive branch read `taxes` too, so `taxPct` reached
   * nothing at all.
   */
  taxPct?: number;
  taxInclusive?: boolean;
}

export interface InvoiceLineBreakdown {
  lineSubtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  taxes: TaxRateResult[];
  taxTotalMinor: number;
  lineTotalMinor: number;
}

export interface InvoiceTotals {
  subtotalMinor: number;
  discountTotalMinor: number;
  taxBreakdown: { code: string; amountMinor: number }[];
  taxTotalMinor: number;
  totalMinor: number;
}

export function computeInvoiceLine(input: InvoiceLineCalcInput): InvoiceLineBreakdown {
  const discountPct = input.discountPct ?? 0;
  // Per-code taxes win when present; a bare taxPct stands in for them so a line
  // described the older way is still taxed, and still respects tax-inclusive
  // pricing, rather than silently coming out at zero.
  const taxes: TaxRateInput[] = input.taxes?.length
    ? input.taxes
    : input.taxPct
      ? [{ code: "TAX", rate: input.taxPct }]
      : [];
  const taxInclusive = input.taxInclusive ?? false;

  const lineSubtotalMinor = Math.round(input.quantity * input.unitPriceMinor);
  const discountMinor = Math.round((lineSubtotalMinor * discountPct) / 100);

  if (taxInclusive && taxes.length > 0) {
    const inclusiveTotalMinor = lineSubtotalMinor - discountMinor;
    const totalRate = taxes.reduce((s, t) => s + t.rate, 0);
    const taxableMinor = Math.round(inclusiveTotalMinor / (1 + totalRate / 100));
    const taxResults: TaxRateResult[] = taxes.map((t) => ({
      code: t.code,
      rate: t.rate,
      amountMinor: Math.round((taxableMinor * t.rate) / 100),
    }));
    const taxTotalMinor = taxResults.reduce((s, t) => s + t.amountMinor, 0);
    return {
      lineSubtotalMinor,
      discountMinor,
      taxableMinor,
      taxes: taxResults,
      taxTotalMinor,
      lineTotalMinor: inclusiveTotalMinor,
    };
  }

  const taxableMinor = lineSubtotalMinor - discountMinor;
  const taxResults: TaxRateResult[] = taxes.map((t) => ({
    code: t.code,
    rate: t.rate,
    amountMinor: Math.round((taxableMinor * t.rate) / 100),
  }));
  const taxTotalMinor = taxResults.reduce((s, t) => s + t.amountMinor, 0);
  return {
    lineSubtotalMinor,
    discountMinor,
    taxableMinor,
    taxes: taxResults,
    taxTotalMinor,
    lineTotalMinor: taxableMinor + taxTotalMinor,
  };
}

export function sumInvoiceTotals(lines: InvoiceLineCalcInput[]): InvoiceTotals {
  const taxMap = new Map<string, number>();
  let subtotalMinor = 0;
  let discountTotalMinor = 0;
  let taxTotalMinor = 0;
  let totalMinor = 0;
  for (const line of lines) {
    const b = computeInvoiceLine(line);
    const inclusive = line.taxInclusive ?? false;
    // When prices are tax-inclusive the entered amounts already contain the
    // tax, so the displayed subtotal must be net of tax (ex-tax) — otherwise
    // Subtotal + Tax would exceed the (unchanged) Total for any tax code.
    // Derive it as total − tax so the breakdown always reconciles exactly.
    // The discount is already baked into the inclusive price, so it is not
    // shown separately in inclusive mode.
    subtotalMinor += inclusive ? b.lineTotalMinor - b.taxTotalMinor : b.lineSubtotalMinor;
    discountTotalMinor += inclusive ? 0 : b.discountMinor;
    taxTotalMinor += b.taxTotalMinor;
    totalMinor += b.lineTotalMinor;
    for (const t of b.taxes) {
      taxMap.set(t.code, (taxMap.get(t.code) ?? 0) + t.amountMinor);
    }
  }
  return {
    subtotalMinor,
    discountTotalMinor,
    taxBreakdown: Array.from(taxMap.entries()).map(([code, amountMinor]) => ({ code, amountMinor })),
    taxTotalMinor,
    totalMinor,
  };
}

/**
 * The adjustment that takes a total to the nearest whole unit of currency.
 *
 * Indian invoices are settled in whole rupees, so the printed total is rounded
 * and the fraction shown on its own line as "Round Off" — a client paying the
 * rounded figure must not leave the invoice a few paise short forever. Returned
 * as the adjustment rather than the rounded total so the invoice can store what
 * it did and print it: a total that silently disagrees with subtotal plus tax
 * is worse than no rounding at all.
 *
 * Whether to round at all is the organization's decision — a dirham invoice
 * should not be — so this says nothing about when to call it.
 */
export function roundingAdjustmentMinor(totalMinor: number): number {
  return Math.round(totalMinor / 100) * 100 - totalMinor;
}

export interface ExpenseTaxBreakdown {
  /** Net of tax. Always what `amountMinor` stores, whichever way it was typed. */
  netMinor: number;
  taxMinor: number;
  /** Gross. Always what `totalMinor` stores. */
  totalMinor: number;
}

/**
 * Split a claimed amount into net and tax.
 *
 * `taxInclusive` says how to read the figure somebody typed, not what gets
 * stored: a receipt shows one number, and whether that number already contains
 * the VAT depends on the receipt, not on us. Either way the net lands in
 * `netMinor` and the gross in `totalMinor`, so every report that sums those
 * keeps meaning the same thing.
 *
 * The tax is taken as the difference rather than computed a second time, so
 * net + tax is exactly the total and a claim can never be a fil out from
 * itself.
 */
export function computeExpenseTax(
  amountMinor: number,
  taxPct: number,
  taxInclusive = false,
): ExpenseTaxBreakdown {
  const amount = Math.round(amountMinor);
  const pct = taxPct > 0 ? taxPct : 0;
  if (pct === 0) return { netMinor: amount, taxMinor: 0, totalMinor: amount };

  if (taxInclusive) {
    const netMinor = Math.round(amount / (1 + pct / 100));
    return { netMinor, taxMinor: amount - netMinor, totalMinor: amount };
  }
  const taxMinor = Math.round((amount * pct) / 100);
  return { netMinor: amount, taxMinor, totalMinor: amount + taxMinor };
}

export interface CashCountResult {
  /** Counted minus book. Positive means more cash than the book expected. */
  differenceMinor: number;
  /** The entry to post so the book agrees with the count. */
  adjustmentMinor: number;
  /** How to describe it: "over" when there is more cash than expected. */
  verdict: "agrees" | "over" | "short";
}

/**
 * Comparing a counted tin with what the book says.
 *
 * One definition because two places say it — the entry the server posts and the
 * warning the dialog shows before it does — and a sign that disagreed with the
 * word beside it would send the balance the wrong way while telling somebody it
 * was going the right one.
 *
 * "Over" means more cash than the book expected, so the adjustment is a credit.
 */
export function compareCashCount(countedMinor: number, bookMinor: number): CashCountResult {
  const differenceMinor = Math.round(countedMinor) - Math.round(bookMinor);
  return {
    differenceMinor,
    adjustmentMinor: differenceMinor,
    verdict: differenceMinor === 0 ? "agrees" : differenceMinor > 0 ? "over" : "short",
  };
}
