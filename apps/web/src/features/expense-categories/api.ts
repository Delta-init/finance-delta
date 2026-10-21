"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ExpenseCategoryRecord,
  CreateExpenseCategoryInput,
  UpdateExpenseCategoryInput,
} from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["expense-categories"] as const;

/**
 * An API from before subcategories (2026-10-21) sends neither the list nor the
 * P&L flag; the website deploys first, so every screen reads them filled in —
 * none, and counting in the P&L — rather than crashing on a missing list.
 */
function complete(c: ExpenseCategoryRecord): ExpenseCategoryRecord {
  const raw = c as Partial<ExpenseCategoryRecord> & ExpenseCategoryRecord;
  return { ...raw, inPnl: raw.inPnl !== false, subcategories: raw.subcategories ?? [] };
}

export function useExpenseCategories() {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => (await api.get<ExpenseCategoryRecord[]>("expense-categories")).map(complete),
    staleTime: 60_000,
  });
}

export function useCreateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: async (input: CreateExpenseCategoryInput) =>
      complete(await api.post<ExpenseCategoryRecord>("expense-categories", input)),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateExpenseCategory(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: async (input: UpdateExpenseCategoryInput) =>
      complete(await api.patch<ExpenseCategoryRecord>(`expense-categories/${id}`, input)),
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
