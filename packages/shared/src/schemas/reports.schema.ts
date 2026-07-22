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
