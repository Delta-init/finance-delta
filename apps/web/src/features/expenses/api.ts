"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateExpenseInput,
  UpdateExpenseInput,
  Expense,
  RejectExpenseInput,
} from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["expenses"] as const;

export function useExpenses(params: QueryParams = {}) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Expense>("expenses", params),
    placeholderData: (prev) => prev,
  });
}

export function useExpense(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<Expense>(`expenses/${id}`),
    enabled: !!id,
  });
}

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateExpenseInput) => api.post<Expense>("expenses", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateExpense(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateExpenseInput) => api.patch<Expense>(`expenses/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

function useExpenseAction(action: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body?: unknown) =>
      body !== undefined
        ? api.post<Expense>(`expenses/${id}/${action}`, body as Record<string, unknown>)
        : api.post<Expense>(`expenses/${id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

export const useSubmitExpense = (id: string) => useExpenseAction("submit", id);
export const useApproveExpense = (id: string) => useExpenseAction("approve", id);
export const useVoidExpense = (id: string) => useExpenseAction("void", id);

export function useRejectExpense(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RejectExpenseInput) =>
      api.post<Expense>(`expenses/${id}/reject`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}
