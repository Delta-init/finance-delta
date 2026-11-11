"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RecordTdsPaymentInput, TdsConfig, TdsReport, UpdateTdsConfigInput } from "@delta/shared";
import { api, qs } from "@/lib/api";

/* TDS on vendor bills — Bangalore (INR books) only (2026-11-11). */
const KEY = ["tds"] as const;

export function useTdsConfig() {
  return useQuery({ queryKey: [...KEY, "config"], queryFn: () => api.get<TdsConfig>("tds/config"), staleTime: 5 * 60 * 1000, retry: false });
}

export function useUpdateTdsConfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateTdsConfigInput) => api.patch<TdsConfig>("tds/config", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useTdsReport(range: { from?: string; to?: string }, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "report", range],
    queryFn: () => api.get<TdsReport>(`tds/report${qs({ from: range.from || undefined, to: range.to || undefined })}`),
    enabled,
    retry: false,
  });
}

export function useRecordTdsPayment() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: RecordTdsPaymentInput) => api.post<{ id: string }>("tds/payments", input),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); void qc.invalidateQueries({ queryKey: ["bank-accounts"] }); },
  });
}

export function useDeleteTdsPayment() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<{ deleted: boolean }>(`tds/payments/${id}`),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); void qc.invalidateQueries({ queryKey: ["bank-accounts"] }); },
  });
}
