"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BalancePayment, DecideBalancePaymentInput } from "@delta/shared";
import { api } from "@/lib/api";
import { APPROVALS_KEY } from "@/features/approvals/api";

/** A balance payment from a sales CRM (2026-10-13), as the Approvals page reviews it. */
const KEY = ["balance-payments"] as const;

export function useBalancePayment(id: string | null) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<BalancePayment>(`balance-payments/${id}`),
    enabled: !!id,
  });
}

export function useDecideBalancePayment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecideBalancePaymentInput) => api.post<BalancePayment>(`balance-payments/${id}/decision`, input),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: KEY });
      // What is waiting changed: the sidebar counts, the pop-up and the table read that.
      qc.invalidateQueries({ queryKey: APPROVALS_KEY });
    },
  });
}
