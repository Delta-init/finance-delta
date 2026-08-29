"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type QueryParams } from "@/lib/api";
import type {
  AdjustmentResult, AvailableBatch, CommissionPullResult,
  ImportPreview, ImportResult, PayResult, Reconciliation, RunDetail, RunSummary,
  PeopleReport, DepartmentReport, PersonDetail,
} from "./types";

const KEY = ["payroll"] as const;

/** What HR is offering across every linked organization. */
export function useAvailableBatches() {
  return useQuery({
    queryKey: [...KEY, "available"],
    queryFn: () => api.get<AvailableBatch[]>("payroll/available"),
    retry: false,
  });
}

/**
 * A dry run of one month's import. Never cached — it compares live against
 * HRMS, and importing on the strength of a stale answer is how a month gets
 * brought in that no longer matches what HR has.
 */
export function useImportPreview(hrmsOrgId: string | null, period: string | null) {
  return useQuery({
    queryKey: [...KEY, "preview", hrmsOrgId, period],
    queryFn: () => api.get<ImportPreview>(`payroll/import/preview?hrmsOrgId=${hrmsOrgId}&period=${period}`),
    enabled: Boolean(hrmsOrgId && period),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useImportRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { hrmsOrgId: string; period: string }) =>
      api.post<ImportResult>("payroll/import", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function usePayrollRuns(params: QueryParams) {
  return useQuery({
    queryKey: [...KEY, "runs", params],
    queryFn: () => api.getList<RunSummary>("payroll/runs", params),
    placeholderData: (prev) => prev,
  });
}

export function usePayrollRun(id: string | null) {
  return useQuery({
    queryKey: [...KEY, "runs", id],
    queryFn: () => api.get<RunDetail>(`payroll/runs/${id}`),
    enabled: Boolean(id),
  });
}

export interface NewAdjustment {
  lineId: string;
  kind: "addition" | "deduction";
  label: string;
  amountMinor: number;
  notes?: string;
}

export function useAddAdjustments(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (items: NewAdjustment[]) =>
      api.post<AdjustmentResult>(`payroll/runs/${runId}/adjustments`, { items }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY, "runs", runId] }),
  });
}

export function usePullCommissions(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<CommissionPullResult>(`payroll/runs/${runId}/commissions/pull`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY, "runs", runId] }),
  });
}

export function useRemoveAdjustment(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (externalId: string) =>
      api.del<{ externalId: string }>(`payroll/runs/${runId}/adjustments/${encodeURIComponent(externalId)}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: [...KEY, "runs", runId] }),
  });
}

export interface PayPayload {
  lineIds?: string[];
  bankAccountId: string;
  method: "bank_transfer" | "cash" | "cheque" | "card" | "online";
  paidOn: string;
  reference?: string;
}

export function useApproveRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ status: string; message: string }>(`payroll/runs/${runId}/approve`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useReturnRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason: string) =>
      api.post<{ status: string; message: string }>(`payroll/runs/${runId}/return`, { reason }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function usePayRun(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: PayPayload) => api.post<PayResult>(`payroll/runs/${runId}/pay`, input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Re-tell HRMS about a payment it never acknowledged. Moves no money. */
export function useRetrySync(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (paymentId: string) =>
      api.post<{ synced: boolean; message: string }>(`payroll/runs/${runId}/payments/${paymentId}/retry-sync`, {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Everything about payroll that needs somebody to look at it. */
export function useReconciliation() {
  return useQuery({
    queryKey: [...KEY, "reconciliation"],
    queryFn: () => api.get<Reconciliation>("payroll/reconciliation"),
    retry: false,
  });
}

export function useReversePayment(runId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ paymentId, reason }: { paymentId: string; reason: string }) =>
      api.post<{ message: string; commissionsReopened: number }>(
        `payroll/runs/${runId}/payments/${paymentId}/reverse`, { reason },
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

// ── People: earned vs cost ───────────────────────────────────────────────────

export function usePeopleReport(params: { from: string; to: string; departmentId?: string; search?: string }) {
  return useQuery({
    queryKey: [...KEY, "people-report", params],
    queryFn: () =>
      api.get<PeopleReport>(
        `payroll/people-report?${new URLSearchParams(
          Object.entries(params).filter(([, v]) => v) as [string, string][],
        )}`,
      ),
    placeholderData: (prev) => prev,
  });
}

export function useDepartmentReport(params: { from: string; to: string }) {
  return useQuery({
    queryKey: [...KEY, "people-report", "departments", params],
    queryFn: () =>
      api.get<DepartmentReport>(`payroll/people-report/departments?from=${params.from}&to=${params.to}`),
    placeholderData: (prev) => prev,
  });
}

export function usePersonDetail(employeeId: string | null, params: { from: string; to: string }) {
  return useQuery({
    queryKey: [...KEY, "people-report", employeeId, params],
    queryFn: () =>
      api.get<PersonDetail>(`payroll/people-report/${employeeId}?from=${params.from}&to=${params.to}`),
    enabled: Boolean(employeeId),
  });
}
