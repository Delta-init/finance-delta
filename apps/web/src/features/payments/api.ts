"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type QueryParams } from "@/lib/api";

export interface PaymentDTO {
  id: string;
  invoiceId: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  method: string;
  amountMinor: number;
  paidOn: string;
  accountName: string;
  reference: string;
  notes: string;
  currency: string;
  createdAt: string;
}

const KEY = ["payments"] as const;

export function usePayments(params: QueryParams = {}) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () =>
      api.get<{ data: PaymentDTO[]; meta: { total: number; page: number; pageSize: number; totalPages: number } }>(
        `payments?${new URLSearchParams(
          Object.fromEntries(
            Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
          )
        ).toString()}`
      ),
    placeholderData: (prev) => prev,
  });
}

export function usePayment(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<PaymentDTO>(`payments/${id}`),
    enabled: !!id,
  });
}

/**
 * Delete a payment from the Payments list (2026-10-16) — the invoice's own
 * delete: its balance and status are worked out again, and its receipt and bank
 * line go with it.
 */
export function useDeletePaymentFromList() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ invoiceId, paymentId }: { invoiceId: string; paymentId: string }) =>
      api.del<unknown>(`invoices/${invoiceId}/payments/${paymentId}`),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoice", v.invoiceId] });
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("bank") });
    },
  });
}
