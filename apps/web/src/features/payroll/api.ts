"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type QueryParams } from "@/lib/api";
import type {
  AdjustmentResult, AvailableBatch, CommissionPullResult,
  ImportPreview, ImportResult, PayResult, RunDetail, RunSummary,
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
