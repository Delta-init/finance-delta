"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BudgetAllocation, BudgetSummaryRow, CreateFundingRequestInput, FundingRequest, ReviewFundingRequestInput, UpsertBudgetAllocationInput } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["budgets"] as const;

export function useBudgetSummary(params: QueryParams, enabled = true) {
  return useQuery({ queryKey: [...KEY, "summary", params], queryFn: () => api.getList<BudgetSummaryRow>("budgets/summary", params), enabled });
}

export function useBudgetAllocations(params: QueryParams, enabled = true) {
  return useQuery({ queryKey: [...KEY, "allocations", params], queryFn: () => api.getList<BudgetAllocation>("budgets/allocations", params), enabled });
}

export function useFundingRequests(params: QueryParams) {
  return useQuery({ queryKey: [...KEY, "requests", params], queryFn: () => api.getList<FundingRequest>("budgets/requests", params) });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: KEY });
}

export function useSaveBudgetAllocation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: UpsertBudgetAllocationInput) => api.patch<BudgetAllocation>("budgets/allocations", input), onSuccess: () => invalidate(qc) });
}

export function useCreateFundingRequest() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: CreateFundingRequestInput) => api.post<FundingRequest>("budgets/requests", input), onSuccess: () => invalidate(qc) });
}

export function useReviewFundingRequest(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (input: ReviewFundingRequestInput) => api.post<FundingRequest>(`budgets/requests/${id}/review`, input), onSuccess: () => invalidate(qc) });
}
