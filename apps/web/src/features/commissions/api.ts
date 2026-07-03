"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CommissionStructure,
  CommissionRecord,
  CommissionReport,
  CreateCommissionStructureInput,
  UpdateCommissionStructureInput,
  MarkCommissionPaidInput,
} from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["commissions"] as const;

// ── Structures ────────────────────────────────────────────────────────────────

export function useCommissionStructures() {
  return useQuery({
    queryKey: [...KEY, "structures"],
    queryFn: () => api.get<CommissionStructure[]>("commissions/structures"),
  });
}

export function useCommissionStructure(id: string) {
  return useQuery({
    queryKey: [...KEY, "structures", id],
    queryFn: () => api.get<CommissionStructure>(`commissions/structures/${id}`),
    enabled: !!id,
  });
}

export function useCreateStructure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCommissionStructureInput) =>
      api.post<CommissionStructure>("commissions/structures", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "structures"] }),
  });
}

export function useUpdateStructure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateCommissionStructureInput }) =>
      api.patch<CommissionStructure>(`commissions/structures/${id}`, input),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: [...KEY, "structures"] });
      qc.invalidateQueries({ queryKey: [...KEY, "structures", id] });
    },
  });
}

export function useLockStructure() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, lock }: { id: string; lock: boolean }) =>
      api.post<CommissionStructure>(
        `commissions/structures/${id}/${lock ? "lock" : "unlock"}`,
        {},
      ),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: [...KEY, "structures"] });
      qc.invalidateQueries({ queryKey: [...KEY, "structures", id] });
    },
  });
}

// ── Records ───────────────────────────────────────────────────────────────────

export function useCommissionRecords(params: {
  salespersonId?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: [...KEY, "records", params],
    queryFn: () => api.getList<CommissionRecord>("commissions/records", params),
  });
}

export function useMarkPaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MarkCommissionPaidInput) =>
      api.post<{ updated: number }>("commissions/records/mark-paid", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "records"] }),
  });
}

export function useCancelRecord() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<CommissionRecord>(`commissions/records/${id}/cancel`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...KEY, "records"] }),
  });
}

// ── Report ────────────────────────────────────────────────────────────────────

export function useCommissionReport(from: string, to: string) {
  return useQuery({
    queryKey: [...KEY, "report", from, to],
    queryFn: () =>
      api.get<CommissionReport>(`commissions/report?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
}
