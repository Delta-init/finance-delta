/**
 * Response shapes for the payroll mapping API.
 *
 * Declared here rather than in `@delta/shared` because nothing on the server
 * imports them back — the API owns its own types and these mirror them for the
 * client. If a third consumer appears, move them across.
 */

export type DeptState = "linked" | "proposed" | "unmatched";
export type EmpState = "linked" | "proposed" | "new" | "conflict" | "orphaned";

export interface IntegrationHealth {
  configured: boolean;
  reachable: boolean;
  message?: string;
  hrmsTime?: string;
}

export interface HrmsOrganization {
  id: string;
  name: string;
  code: string;
  currency: string;
  timeZone: string;
  status: string;
  linked: boolean;
  linkedToThisOrg: boolean;
  linkId: string | null;
}

export interface OrgLink {
  id: string;
  hrmsOrgId: string;
  hrmsOrgName: string;
  hrmsOrgCode: string;
  hrmsCurrency: string;
  isActive: boolean;
  lastSyncedAt: string | null;
  linkedByName: string;
}

export interface CreatedOrgLink {
  id: string;
  hrmsOrgId: string;
  hrmsOrgName: string;
  currencyMismatch: { hrms: string; finance: string } | null;
}

export interface DeptRow {
  hrmsDepartmentId: string;
  hrmsDepartmentName: string;
  state: DeptState;
  departmentId: string | null;
  departmentName: string | null;
  reason: string;
}

export interface EmpRow {
  hrmsEmployeeId: string;
  employeeCode: string;
  name: string;
  email: string;
  hrmsStatus: string;
  hasBankDetails: boolean;
  hrmsDepartmentId: string | null;
  state: EmpState;
  employeeId: string | null;
  userId: string | null;
  userName: string | null;
  issues: string[];
  changes: { field: string; from: string; to: string }[];
}

export interface SyncPreview {
  hrmsOrgId: string;
  hrmsOrgName: string;
  departments: DeptRow[];
  employees: EmpRow[];
  summary: {
    departments: { linked: number; proposed: number; unmatched: number };
    employees: { linked: number; proposed: number; new: number; conflict: number; orphaned: number };
    blockers: { noBankDetails: number; unmappedDepartment: number };
  };
}

export interface SyncDecision {
  kind: "department" | "employee";
  hrmsId: string;
  action: "link" | "create" | "deactivate" | "skip";
  targetDepartmentId?: string;
  targetUserId?: string;
}

export interface ApplyResult {
  departmentsLinked: number;
  departmentsCreated: number;
  employeesLinked: number;
  employeesCreated: number;
  employeesDeactivated: number;
  skipped: number;
  errors: { hrmsId: string; message: string }[];
}

export interface MappedEmployee {
  id: string;
  hrmsOrgId: string;
  hrmsEmployeeId: string;
  employeeCode: string;
  name: string;
  email: string;
  designation: string;
  department: string | null;
  userId: string | null;
  status: "active" | "inactive";
  hrmsStatus: string;
  payable: boolean;
  hasBankDetails: boolean;
  /** Holds a finance login with an active commission structure against it. */
  isSalesperson: boolean;
  commissionEarnedMinor: number;
  commissionPaidMinor: number;
  lastSyncedAt: string | null;
}
