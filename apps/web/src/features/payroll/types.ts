export type RunStatus =
  | "imported" | "additions" | "approved" | "partially_paid" | "paid" | "returned" | "voided";

export type LineStatus = "pending" | "on_hold" | "partially_paid" | "paid";

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  imported: "Imported",
  additions: "Adding",
  approved: "Approved",
  partially_paid: "Partly paid",
  paid: "Paid",
  returned: "Sent back",
  voided: "Voided",
};

export interface AvailableBatch {
  hrmsOrgId: string;
  hrmsOrgName: string;
  period: string;
  status: string;
  currency: string;
  employeeCount: number;
  netTotal: number;
  imported: boolean;
  /** The state of the run that owns this month, when there is one. */
  runStatus?: string | null;
  runNumber: string | null;
}

export interface ImportPreview {
  period: string;
  hrmsOrgId: string;
  hrmsOrgName: string;
  currency: string;
  canImport: boolean;
  blockers: string[];
  warnings: string[];
  totals: { employeeCount: number; grossMinor: number; deductionsMinor: number; netMinor: number };
  /** On the payroll but not yet mapped in finance — a sync fixes these. */
  unmapped: Array<{ hrmsEmployeeId: string; employeeCode: string; name: string }>;
  /** Payslips whose employee was deleted in HRMS — a sync cannot fix these. */
  orphaned: Array<{ hrmsEmployeeId: string; employeeCode: string; name: string }>;
  unpayable: Array<{ employeeCode: string; name: string }>;
  alreadyImported: { runNumber: string; status: string } | null;
}

export interface ImportResult {
  id: string;
  runNumber: string;
  period: string;
  currency: string;
  employeeCount: number;
  netMinor: number;
  netFormatted: string;
  warnings: string[];
}

export interface RunSummary {
  id: string;
  runNumber: string;
  period: string;
  hrmsOrgName: string;
  currency: string;
  status: RunStatus;
  payableMinor: number;
  amountPaidMinor: number;
  balanceMinor: number;
  importedAt: string | null;
  importedByName: string;
}

export interface RunLine {
  id: string;
  hrmsEmployeeId: string;
  employeeId: string | null;
  employeeCode: string;
  name: string;
  designation: string;
  departmentName: string;
  /** What this person is paid in. Need not match the run's own currency. */
  currency: string;
  earnings: Array<{ label: string; amountMinor: number }>;
  deductions: Array<{ label: string; amountMinor: number }>;
  grossMinor: number;
  deductionsMinor: number;
  netFromHrmsMinor: number;
  adjustmentsMinor: number;
  payableMinor: number;
  amountPaidMinor: number;
  status: LineStatus;
  holdReason: string;
  payable: boolean;
  bank: { iban: string; accountNumber: string; bankName: string; nameInBank: string };
}

export interface RunDetail {
  id: string;
  runNumber: string;
  period: string;
  hrmsOrgId: string;
  hrmsOrgName: string;
  currency: string;
  status: RunStatus;
  totals: {
    employeeCount: number;
    hrmsGrossMinor: number;
    hrmsDeductionsMinor: number;
    hrmsNetMinor: number;
    adjustmentsMinor: number;
    payableMinor: number;
    amountPaidMinor: number;
    balanceMinor: number;
    heldCount: number;
  };
  /**
   * The totals split by what each person is paid in.
   *
   * One entry means the run is single-currency and `totals` above is a real
   * figure. More than one means `totals` adds unlike things together, and the
   * page shows this instead.
   */
  byCurrency: RunCurrencyTotals[];
  lines: RunLine[];
  adjustments: RunAdjustment[];
  payments: RunPayment[];
  importedAt: string | null;
  importedByName: string;
  notes: string;
}

export interface RunCurrencyTotals {
  currency: string;
  employeeCount: number;
  grossMinor: number;
  deductionsMinor: number;
  payableMinor: number;
  amountPaidMinor: number;
}

export interface RunAdjustment {
  externalId: string;
  hrmsEmployeeId: string;
  lineId: string;
  kind: "addition" | "deduction";
  source: "commission" | "manual";
  label: string;
  amountMinor: number;
  notes: string;
  /** What HRMS actually took. Below `amountMinor` when the month could not afford it. */
  recoveredMinor: number;
  outstandingMinor: number;
  syncedAt: string | null;
  createdByName: string;
}

export interface AdjustmentResult {
  runId: string;
  adjustmentsMinor: number;
  payableMinor: number;
  /**
   * Plain-language surprises. Adding money can change deductions, because a
   * bonus can make a loan instalment affordable that the month was carrying —
   * so these say what actually happened rather than what was asked for.
   */
  notes: string[];
}

export interface CommissionPullResult extends Partial<AdjustmentResult> {
  pulled: number;
  message: string;
}

export interface RunPayment {
  paymentId: string;
  method: string;
  paidOn: string;
  reference: string;
  bankAccountName: string;
  amountMinor: number;
  payslipCount: number;
  /** False means the money moved but HRMS still shows the payslips as issued. */
  syncedToHrms: boolean;
  syncError: string;
  reversedAt: string | null;
  reversalReason: string;
  createdByName: string;
}

export interface PayResult {
  paymentId: string;
  runNumber: string;
  status: RunStatus;
  paidCount: number;
  amountMinor: number;
  amountFormatted: string;
  bankTransactionId: string;
  commissionsSettled: number;
  heldCount: number;
  synced: boolean;
  warning: string | null;
}

export interface Reconciliation {
  unsyncedPayments: Array<{
    runId: string; runNumber: string; period: string; paymentId: string;
    amountMinor: number; currency: string; paidOn: string; error: string; attempts: number;
  }>;
  heldPeople: Array<{
    runId: string; runNumber: string; period: string; currency: string;
    name: string; employeeCode: string; reason: string; payableMinor: number;
  }>;
  unfinished: Array<{
    runId: string; runNumber: string; period: string; currency: string;
    status: string; outstandingMinor: number; peopleLeft: number;
  }>;
  total: number;
}

// ── People: earned vs cost ───────────────────────────────────────────────────

/**
 * `totalCostMinor` is payroll paid plus expenses. Commission is *inside*
 * payrollPaidMinor, never added to it — it reaches people as an addition on a
 * payroll run, so counting it separately would double every commission payment.
 */
export interface PersonRow {
  employeeId: string;
  employeeCode: string;
  name: string;
  designation: string;
  departmentId: string | null;
  departmentName: string;
  userId: string | null;
  status: "active" | "inactive";
  invoiceCount: number;
  invoicedMinor: number;
  payrollPaidMinor: number;
  expensesMinor: number;
  totalCostMinor: number;
  commissionInPayrollMinor: number;
  commissionOutstandingMinor: number;
}

export interface PeopleReportTotals {
  people: number;
  invoiceCount: number;
  invoicedMinor: number;
  payrollPaidMinor: number;
  expensesMinor: number;
  totalCostMinor: number;
  commissionInPayrollMinor: number;
  commissionOutstandingMinor: number;
}

export interface PeopleReport {
  rows: PersonRow[];
  totals: PeopleReportTotals;
  currency: string;
}

export interface DepartmentSummary {
  departmentId: string | null;
  name: string;
  headcount: number;
  invoicedMinor: number;
  payrollPaidMinor: number;
  expensesMinor: number;
  totalCostMinor: number;
  commissionInPayrollMinor: number;
}

export interface DepartmentReport {
  departments: DepartmentSummary[];
  currency: string;
}

export interface PersonDetail {
  person: {
    employeeId: string; employeeCode: string; name: string; email: string;
    designation: string; departmentId: string | null; departmentName: string;
    status: string; hasLogin: boolean;
  };
  summary: PersonRow | null;
  payslips: Array<{
    runId: string; runNumber: string; period: string; status: string; currency: string;
    grossMinor: number; deductionsMinor: number; payableMinor: number;
    amountPaidMinor: number; commissionMinor: number;
  }>;
  invoices: Array<{
    id: string; invoiceNumber: string; customerName: string;
    issueDate: string; totalMinor: number; status: string; currency: string;
  }>;
  expenses: Array<{
    id: string; expenseNumber: string; description: string; categoryName: string;
    expenseDate: string; totalMinor: number; status: string; currency: string;
  }>;
  commissions: Array<{
    id: string; invoiceNumber: string; commissionMinor: number;
    status: string; calculatedAt: string | null; paidAt: string | null;
  }>;
}
