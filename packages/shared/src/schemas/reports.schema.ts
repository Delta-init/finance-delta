// ── Shared report response types ──────────────────────────────────────────────
// No Zod needed — these are server-computed outputs, not user inputs.

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
  currency: string;
  departmentId: string | null;
  rows: DailyReportRow[];
  totals: {
    incomeMinor: number;
    expenseMinor: number;
    revenueMinor: number;
    netMinor: number;
  };
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
  totalMinor: number;
  count: number;
  groups: DailyBreakdownGroup[];
  records: DailyBreakdownRecord[];
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
  /** In the organization's currency; a credit note is negative. */
  amountMinor: number;
  href: string;
  /** Its key in each dimension; the names are in the report's options. */
  dims: Record<string, string>;
};

export type AnalysisOption = { key: string; name: string; count: number };

export type AnalysisGroup = {
  key: string;
  name: string;
  count: number;
  amountMinor: number;
  /** A category's subcategories, when grouped by category. */
  sub?: AnalysisGroup[];
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
  /** More records matched than are listed (the newest are). */
  capped: boolean;
};

// ── 8.2 Payables ──────────────────────────────────────────────────────────────

export type MadePaymentsReport = {
  from: string;
  to: string;
  currency: string;
  totalMinor: number;
  byVendor: { vendorId: string; vendorName: string; amountMinor: number }[];
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
};

// ── 8.3 Profit & Loss ─────────────────────────────────────────────────────────

export type PLCategory = { label: string; amountMinor: number };

export type PLPeriod = {
  from: string;
  to: string;
  income: { total: number; breakdown: PLCategory[] };
  expenses: { total: number; breakdown: PLCategory[] };
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
  grandTotalMinor: number;
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
  grandTotalMinor: number;
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
