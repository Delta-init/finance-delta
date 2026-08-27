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
  unmapped: Array<{ hrmsEmployeeId: string; employeeCode: string; name: string }>;
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
  lines: RunLine[];
  importedAt: string | null;
  importedByName: string;
  notes: string;
}
