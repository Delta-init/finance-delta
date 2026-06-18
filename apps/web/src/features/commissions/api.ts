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

interface RecordsResult {
  data: CommissionRecord[];
  meta: { total: number; page: number; pageSize: number; pageCount: number };
}

export function useCommissionRecords(params: {
  salespersonId?: string;
  status?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}) {
  const qs = new URLSearchParams();
  if (params.salespersonId) qs.set("salespersonId", params.salespersonId);
  if (params.status) qs.set("status", params.status);
  if (params.from) qs.set("from", params.from);
  if (params.to) qs.set("to", params.to);
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));

  return useQuery({
    queryKey: [...KEY, "records", params],
    queryFn: () => api.get<RecordsResult>(`commissions/records?${qs.toString()}`),
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
