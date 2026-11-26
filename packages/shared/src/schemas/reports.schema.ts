// ── Shared report response types ──────────────────────────────────────────────
// No Zod needed — these are server-computed outputs, not user inputs.

/**
 * Money in a currency other than the organization's, left out of a report's figures (the user, 2026-11-26: "fix the
 * same currency mixing in the dashboard and the other reports too" — each added every amount whatever its currency,
 * so rupees went into a dirham total as dirhams). A line per currency and per figure it would have gone into (`what`),
 * as recorded — never converted, never added in.
 */
export type OtherCurrencyLine = { currency: string; what: string; amountMinor: number; count: number };

export type AgedItem = {
  id: string;
  number: string;
  partyName: string;
  issuedDate: string;
  dueDate: string;
  totalMinor: number;
  balanceMinor: number;
  daysOverdue: number;
};

export type AgedTotals = {
  current: number;
  band1to30: number;
  band31to60: number;
  band61to90: number;
  band90plus: number;
  grand: number;
};

// ── 8.1 Receivables ───────────────────────────────────────────────────────────

export type ReceivedPaymentsReport = {
  from: string;
  to: string;
  currency: string;
  totalMinor: number;
  byPeriod: { label: string; amountMinor: number }[];
  /** What is in another currency than the organization's — apart, as recorded; not in the figures above. Absent: none. */
  otherCurrencies?: OtherCurrencyLine[];
};

export type AgedReceivablesReport = {
  asOf: string;
  currency: string;
  current: AgedItem[];
  band1to30: AgedItem[];
  band31to60: AgedItem[];
  band61to90: AgedItem[];
  band90plus: AgedItem[];
  totals: AgedTotals;
  /** What is in another currency than the organization's — apart, as recorded; not in the figures above. Absent: none. */
  otherCurrencies?: OtherCurrencyLine[];
};

export type InvoiceSummaryGroup = {
  id: string;
  label: string;
  count: number;
  totalMinor: number;
  paidMinor: number;
  outstandingMinor: number;
};

export type InvoiceSummaryReport = {
  from: string;
  to: string;
  currency: string;
  groupBy: "salesperson" | "customer" | "tag" | "department";
  items: InvoiceSummaryGroup[];
  /** What is in another currency than the organization's — apart, as recorded; not in the figures above. Absent: none. */
  otherCurrencies?: OtherCurrencyLine[];
};

// ── 8.1d Daily income / expense / revenue ─────────────────────────────────────

export type DailyReportRow = {
  date: string; // YYYY-MM-DD
  incomeMinor: number; // payments received that day
  expenseMinor: number; // approved/submitted expenses dated that day
  revenueMinor: number; // invoiced (issue date) that day, excl. draft/void
  netMinor: number; // income − expense
};

export type DailyReport = {
  from: string;
  to: string;
  /** The currency the rows and totals are in (2026-11-07: never two added together) — picked with ?currency=. */
  currency: string;
  departmentId: string | null;
  rows: DailyReportRow[];
  totals: {
    incomeMinor: number;
    expenseMinor: number;
    revenueMinor: number;
    netMinor: number;
  };
  /** Every currency in the period, the organization's first, and its totals — for the cards. */
  currencies?: string[];
  byCurrency?: Array<DailyReport["totals"] & { currency: string }>;
  /**
   * Income paid in a currency other than its invoice's (2026-11-13): counted under that currency as it was paid, not
   * in the invoice's — a line for each with what it was recorded as, and the payments still counted in the invoice's
   * currency because their amount was never recorded.
   */
  otherCurrencyIncome?: { lines: Array<{ currency: string; amountMinor: number; recordedMinor: number }>; notRecordedCount: number; notRecordedMinor: number };
};

/**
 * Where a Daily Report figure came from (the user, 2026-10-21: "when we click on stats we can see where it came
 * from"): the records behind income (payments received), expenses or revenue (invoices issued) over a range — a day
 * or the whole report — by the report's own rules, so they add up to the figure clicked; and their totals grouped
 * (income: by method, salesperson, CRM; revenue: by salesperson, CRM; expenses: by category, department, who
 * submitted it, status).
 */
export type DailyBreakdownKind = "income" | "expense" | "revenue";

export type DailyBreakdownRecord = {
  id: string;
  date: string; // YYYY-MM-DD
  number: string;
  title: string;
  detail: string;
  amountMinor: number;
  currency: string;
  href: string;
  /** The record's value for each grouping (group key → name). */
  groups: Record<string, string>;
};

export type DailyBreakdownGroup = {
  key: string;
  label: string;
  items: { name: string; count: number; amountMinor: number }[];
};

export type DailyBreakdown = {
  kind: DailyBreakdownKind;
  from: string;
  to: string;
  departmentId: string | null;
  /** The currency its totals, groups and records are in (2026-11-07). */
  currency?: string;
  totalMinor: number;
  count: number;
  groups: DailyBreakdownGroup[];
  records: DailyBreakdownRecord[];
  /** Every currency in it, the organization's first, with its total. */
  currencies?: string[];
  byCurrency?: Array<{ currency: string; totalMinor: number; count: number }>;
};

// ── Dashboard breakdowns (the user, 2026-10-26) ──────────────────────────────

/**
 * Where a dashboard figure came from ("breakdown of the stat and graph and all"): the records behind it, by the
 * dashboard's own rules so they add up to the figure clicked, and their totals grouped.
 *   revenue, expenses, cash_in, cash_out — one month (`month` YYYY-MM, Dubai);
 *   receivables, overdue, payables — as of today; aging — one band of receivables (`band`);
 *   category — an expense category's last three months (`category`, its slug); customer — a client's last six
 *   months of invoices (`customer`, the name).
 */
export const DASHBOARD_BREAKDOWN_KINDS = ["revenue", "expenses", "cash_in", "cash_out", "receivables", "overdue", "aging", "payables", "category", "customer"] as const;
export type DashboardBreakdownKind = (typeof DASHBOARD_BREAKDOWN_KINDS)[number];

/** How far past its due date a receivable is, as the dashboard's aging bands. */
export const AGING_BANDS = ["current", "1-30", "31-60", "61-90", "90+"] as const;
export type AgingBand = (typeof AGING_BANDS)[number];
export const AGING_BAND_LABELS: Record<AgingBand, string> = {
  current: "Not due yet", "1-30": "1–30 days late", "31-60": "31–60 days late", "61-90": "61–90 days late", "90+": "Over 90 days late",
};

export type DashboardBreakdown = {
  kind: DashboardBreakdownKind;
  title: string;
  /** What it covers, in words: "October 2026", "as of 26 Oct 2026", "Aug – Oct 2026". */
  scope: string;
  totalMinor: number;
  count: number;
  groups: DailyBreakdownGroup[];
  records: DailyBreakdownRecord[];
  /** What is in another currency than the organization's: apart, as recorded; not in the total, groups or records. Absent: none. */
  otherCurrencies?: OtherCurrencyLine[];
};

// ── Expense and Revenue reports (the user, 2026-10-24) ───────────────────────

/*
 * "A report on expenses and revenue — by category, by employee, by department, with more filters." Each record keeps
 * its key in every dimension (category, employee, department, …); the report groups by one of them, and filters by
 * any. The names behind the keys are in `options`, which lists every value found in the period before the filters,
 * so a filter can't hide its own choices.
 */
export const EXPENSE_DIMENSIONS = ["category", "subcategory", "employee", "submittedBy", "department", "method", "bank", "source", "status", "paid", "month"] as const;
export type ExpenseDimension = (typeof EXPENSE_DIMENSIONS)[number];
export const REVENUE_DIMENSIONS = ["salesperson", "department", "course", "customer", "crm", "academy", "method", "bank", "status", "month"] as const;
export type RevenueDimension = (typeof REVENUE_DIMENSIONS)[number];

export const ANALYSIS_DIMENSION_LABELS: Record<ExpenseDimension | RevenueDimension, string> = {
  category: "Category", subcategory: "Subcategory", employee: "Employee", submittedBy: "Submitted by", department: "Department",
  method: "Payment method", bank: "Bank account", source: "Source", status: "Status", paid: "Paid or not", month: "Month",
  salesperson: "Salesperson", course: "Course / product", customer: "Customer", crm: "CRM", academy: "Academy",
};

export type AnalysisRecord = {
  id: string;
  date: string; // YYYY-MM-DD
  number: string;
  title: string;
  detail: string;
  /** In `currency`; a credit note is negative. */
  amountMinor: number;
  /** Its own currency (2026-11-07) — the report never adds two currencies together. Absent: the report's. */
  currency?: string;
  /** Revenue under Invoiced: paid on this invoice so far, and still owed on it (2026-10-30: a part-paid invoice showed only its total). */
  collectedMinor?: number;
  owedMinor?: number;
  /**
   * Revenue under Collected (2026-11-26): a payment made in another currency than its invoice's — `amountMinor` is
   * what was paid, in `currency`; this is what it was recorded as, in the report's currency.
   */
  recordedMinor?: number;
  /** Paid in this currency, but the amount in it was never recorded — so it is counted as recorded, in the report's. */
  paidIn?: string;
  href: string;
  /** Its key in each dimension; the names are in the report's options. */
  dims: Record<string, string>;
};

/** Money paid in one currency other than the invoices' own: as it was paid, never converted. */
export type AnalysisForeign = { currency: string; amountMinor: number; count: number };

export type AnalysisOption = { key: string; name: string; count: number };

export type AnalysisGroup = {
  key: string;
  name: string;
  count: number;
  amountMinor: number;
  /** Its records' collected and still owed, when they carry them (revenue under Invoiced). */
  collectedMinor?: number;
  owedMinor?: number;
  /** A category's subcategories, when grouped by category. */
  sub?: AnalysisGroup[];
  /**
   * Revenue (2026-11-25): the same key's money in the other organization (Delta Banglore, in rupees) — shown beside,
   * never added. A group with only this has count and amountMinor 0.
   */
  other?: { amountMinor: number; count: number };
  /**
   * Revenue under Collected (2026-11-26): the same key's payments made in other currencies (rupees on an AED invoice)
   * — a line per currency, as paid; not in `amountMinor` or `count`. A group with only these has both 0.
   */
  foreign?: AnalysisForeign[];
};

export type AnalysisReport = {
  kind: "expense" | "revenue";
  from: string;
  to: string;
  currency: string;
  /** Expenses: "expense" (expense date) or "paid" (paid date). Revenue: "invoiced" (issue date) or "collected" (payment date). */
  basis: string;
  groupBy: string;
  totals: {
    amountMinor: number;
    count: number;
    /** Expenses. */
    paidMinor?: number;
    unpaidMinor?: number;
    /** Revenue: invoiced before credit notes, the credit notes, collected in the period, still owed on these invoices. */
    invoicedMinor?: number;
    creditMinor?: number;
    collectedMinor?: number;
    outstandingMinor?: number;
  };
  groups: AnalysisGroup[];
  months: { month: string; amountMinor: number; count: number }[];
  options: Record<string, AnalysisOption[]>;
  records: AnalysisRecord[];
  /**
   * Every currency the filters matched, the organization's first (the user, 2026-11-07: "INR shows as AED — a separate
   * view for INR, like the expense cards"): the cards show each; totals, groups, months and records are `currency`'s,
   * picked with ?currency=.
   */
  currencies?: string[];
  byCurrency?: Array<AnalysisReport["totals"] & { currency: string }>;
  /** More records matched than are listed (the newest are). */
  capped: boolean;
  /**
   * Revenue (the user, 2026-11-25: "if Bangalore received the amount, also show here and mention it's in Bangalore"):
   * the same period, filters and grouping in the organization keeping its books in rupees — its own currency, never
   * converted or added to the figures above. Absent: there is none, or the viewer isn't in it.
   */
  other?: {
    organizationId: string;
    organizationName: string;
    currency: string;
    amountMinor: number;
    count: number;
    records: AnalysisRecord[];
  };
  /**
   * Revenue under Collected (the user, 2026-11-26: "show INR collected as separate instead of summing AED, same as
   * the payment page"): payments made in another currency than their invoice's — rupees on an AED invoice — as they
   * were paid, never converted, and not in the totals, groups or records above. A line per currency: what was paid
   * and how many, what those were recorded as in the report's currency, and the payments whose amount in that
   * currency was never recorded (those stay in the totals). Absent: there are none.
   */
  foreign?: {
    lines: Array<AnalysisForeign & { recordedMinor: number; unknownCount: number; unknownMinor: number }>;
    /** Those payments, the newest first — each with its `currency` and `recordedMinor`. */
    records: AnalysisRecord[];
  };
};

// ── 8.2 Payables ──────────────────────────────────────────────────────────────

export type MadePaymentsReport = {
  from: string;
  to: string;
  currency: string;
  totalMinor: number;
  byVendor: { vendorId: string; vendorName: string; amountMinor: number }[];
  /** What is in another currency than the organization's — apart, as recorded; not in the figures above. Absent: none. */
  otherCurrencies?: OtherCurrencyLine[];
};

export type AgedPayablesReport = {
  asOf: string;
  currency: string;
  current: AgedItem[];
  band1to30: AgedItem[];
  band31to60: AgedItem[];
  band61to90: AgedItem[];
  band90plus: AgedItem[];
  totals: AgedTotals;
  /** What is in another currency than the organization's — apart, as recorded; not in the figures above. Absent: none. */
  otherCurrencies?: OtherCurrencyLine[];
};

// ── 8.3 Profit & Loss ─────────────────────────────────────────────────────────

export type PLCategory = { label: string; amountMinor: number };

/**
 * Expenses and supplier bills in a currency other than the organization's (2026-11-26): INR 20,000 of rent was added
 * into an AED total as 20,000 dirhams. They are out of `expenses.total`, its breakdown and the net profit, and given
 * here as they were recorded — a line per currency, in that currency, never converted or added in.
 */
export type PLOtherCurrency = { currency: string; amountMinor: number; count: number; breakdown: PLCategory[] };

export type PLPeriod = {
  from: string;
  to: string;
  /** `total`: invoices in the organization's own currency only; one in another currency is in `otherCurrencies`. */
  income: { total: number; breakdown: PLCategory[]; otherCurrencies?: OtherCurrencyLine[] };
  /** `total` and `breakdown`: the organization's own currency only. `otherCurrencies`: the rest, apart — absent when there is none. */
  expenses: { total: number; breakdown: PLCategory[]; otherCurrencies?: PLOtherCurrency[] };
  netProfitMinor: number;
};

export type PLReport = PLPeriod & {
  currency: string;
  prior: PLPeriod | null;
};

// ── 8.4 Balance Sheet ─────────────────────────────────────────────────────────

export type BalanceSheetReport = {
  asOf: string;
  currency: string;
  assets: {
    accountsReceivable: number;
    total: number;
  };
  liabilities: {
    accountsPayable: number;
    total: number;
  };
  equity: number;
  /** What is in another currency than the organization's — apart, as recorded; not in the figures above. Absent: none. */
  otherCurrencies?: OtherCurrencyLine[];
};

// ── 8.5 Cash Flow ─────────────────────────────────────────────────────────────

export type CashFlowReport = {
  from: string;
  to: string;
  currency: string;
  operating: { inflows: number; outflows: number; net: number };
  investing: { net: number };
  financing: { net: number };
  netChange: number;
  /** What is in another currency than the organization's — apart, as recorded; not in the figures above. Absent: none. */
  otherCurrencies?: OtherCurrencyLine[];
};

// ── 8.6 Tax ───────────────────────────────────────────────────────────────────

export type VATReport = {
  from: string;
  to: string;
  currency: string;
  outputTaxMinor: number;
  inputTaxMinor: number;
  netPayableMinor: number;
  byRate: { code: string; rate: number; outputMinor: number; inputMinor: number }[];
};

// ── 8.7 Other ─────────────────────────────────────────────────────────────────

export type SalesItemRow = {
  itemId: string | null;
  description: string;
  qty: number;
  revenueMinor: number;
  avgPriceMinor: number;
};

export type SalesByItemReport = {
  from: string;
  to: string;
  currency: string;
  items: SalesItemRow[];
  grandTotalMinor: number;  /** What is in another currency than the organization's — apart, as recorded; not in the figures above. Absent: none. */
  otherCurrencies?: OtherCurrencyLine[];
};

export type ExpenseCategoryRow = {
  category: string;
  count: number;
  totalMinor: number;
};

export type ExpenseByCategoryReport = {
  from: string;
  to: string;
  currency: string;
  categories: ExpenseCategoryRow[];
  grandTotalMinor: number;  /** What is in another currency than the organization's — apart, as recorded; not in the figures above. Absent: none. */
  otherCurrencies?: OtherCurrencyLine[];
};

export type CustomerStatementLine = {
  date: string;
  type: "invoice" | "payment" | "credit_note";
  number: string;
  description: string;
  debitMinor: number;
  creditMinor: number;
  balanceMinor: number;
};

export type CustomerStatementReport = {
  from: string;
  to: string;
  currency: string;
  customerId: string;
  customerName: string;
  openingBalanceMinor: number;
  closingBalanceMinor: number;
  lines: CustomerStatementLine[];
};
