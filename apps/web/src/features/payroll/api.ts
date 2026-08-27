"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type QueryParams } from "@/lib/api";
import type { AvailableBatch, ImportPreview, ImportResult, RunDetail, RunSummary } from "./types";

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
