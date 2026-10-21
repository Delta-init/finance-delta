"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApproveCrmCommissionInput, CrmCommissionMonth, PayCrmCommissionInput, RevokeCrmCommissionInput, UploadedExpenseFile } from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["crm-commission"] as const;

/** A month of the sales CRMs' commission, read live through Root (2026-10-21). */
export function useCrmCommission(month: string) {
  return useQuery({
    queryKey: [...KEY, month],
    queryFn: () => api.get<CrmCommissionMonth>(`crm-commission?month=${month}`),
    enabled: /^\d{4}-\d{2}$/.test(month),
    retry: false,
  });
}

export function useApproveCrmCommission() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: ApproveCrmCommissionInput) => api.post<{ approved: true }>("crm-commission/approve", input),
    onSettled: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useRevokeCrmCommission() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: RevokeCrmCommissionInput) => api.post<{ revoked: true }>("crm-commission/revoke", input),
    onSettled: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export async function uploadCommissionReceipt(file: File): Promise<UploadedExpenseFile> {
  const form = new FormData();
  form.append("file", file);
  return api.postForm<UploadedExpenseFile>("crm-commission/uploads", form);
}

export function usePayCrmCommission() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: PayCrmCommissionInput) => api.post<{ expense: { id: string; expenseNumber: string } }>("crm-commission/pay", input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}
