"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateBillInput, UpdateBillInput, Bill, RecordBillPaymentInput } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["bills"] as const;

export function useBills(params: QueryParams = {}) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Bill>("bills", params),
    placeholderData: (prev) => prev,
  });
}

export function useBill(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<Bill>(`bills/${id}`),
    enabled: !!id,
  });
}

export function useCreateBill() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateBillInput) => api.post<Bill>("bills", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateBill(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateBillInput) => api.patch<Bill>(`bills/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

function useBillAction(action: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (body?: unknown) =>
      body !== undefined
        ? api.post<Bill>(`bills/${id}/${action}`, body as Record<string, unknown>)
        : api.post<Bill>(`bills/${id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

export const useApproveBill = (id: string) => useBillAction("approve", id);
export const useRejectBill = (id: string) => useBillAction("reject", id);
export const useVoidBill = (id: string) => useBillAction("void", id);

export function useRecordBillPayment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: RecordBillPaymentInput) => api.post<Bill>(`bills/${id}/payments`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}
