"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ExpenseCategoryRecord,
  CreateExpenseCategoryInput,
  UpdateExpenseCategoryInput,
} from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["expense-categories"] as const;

export function useExpenseCategories() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<ExpenseCategoryRecord[]>("expense-categories"),
    staleTime: 60_000,
  });
}

export function useCreateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateExpenseCategoryInput) =>
      api.post<ExpenseCategoryRecord>("expense-categories", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateExpenseCategory(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateExpenseCategoryInput) =>
      api.patch<ExpenseCategoryRecord>(`expense-categories/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      // Category names are denormalized onto expenses — refresh those too.
      qc.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

export function useDeleteExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<{ id: string }>(`expense-categories/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
