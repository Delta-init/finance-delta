"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DecideTetraDepositInput, PageMeta, TetraDeposit, TetraDepositCounts, TetraDepositDecisionResult, TetraDepositView,
} from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";
import { APPROVALS_KEY } from "@/features/approvals/api";

const KEY = ["tetra-deposits"] as const;

/** Tetra Commission's deposit requests — waiting, needing attention, or recently decided. */
export function useTetraDeposits(view: TetraDepositView, enabled = true) {
  return useQuery({
    queryKey: [...KEY, view],
    queryFn: () => api.getList<TetraDeposit>("tetra-deposits", { view }),
    enabled,
    // A request raised in Tetra Commission should turn up without a reload.
    refetchInterval: 60_000,
  });
}

/** The deposits page: every deposit, by status, searched and paged, with each status's count. */
export function useTetraDepositList(params: QueryParams, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "list", params],
    queryFn: async () => {
      const { data, meta } = await api.getList<TetraDeposit>("tetra-deposits/list", params);
      return { data, meta: meta as PageMeta & { counts?: TetraDepositCounts } };
    },
    enabled,
  });
}

/** One deposit, with its history here. */
export function useTetraDeposit(id: string | null) {
  return useQuery({
    queryKey: [...KEY, "one", id],
    queryFn: () => api.get<TetraDeposit>(`tetra-deposits/${id}`),
    enabled: !!id,
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: KEY });
  // What is waiting changed: the sidebar counts and the pop-up read that.
  qc.invalidateQueries({ queryKey: APPROVALS_KEY });
}

export function useDecideTetraDeposit(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecideTetraDepositInput) => api.post<TetraDepositDecisionResult>(`tetra-deposits/${id}/decision`, input),
    // Refused too: a refusal may have closed it, or put it back.
    onSettled: () => invalidate(qc),
  });
}

export function useReopenTetraDeposit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<TetraDeposit>(`tetra-deposits/${id}/reopen`),
    onSettled: () => invalidate(qc),
  });
}
