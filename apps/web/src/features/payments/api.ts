"use client";

import { useQuery } from "@tanstack/react-query";
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
