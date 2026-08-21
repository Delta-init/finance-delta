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

/** Parse a major-unit string/number (e.g. "10.50") into minor units (1050). */
export function toMinor(major: number | string): number {
  const n = typeof major === "string" ? parseFloat(major) : major;
  return Math.round((Number.isFinite(n) ? n : 0) * 100);
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
  const taxes = input.taxes ?? [];
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
