"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreatePOInput, UpdatePOInput, PurchaseOrder } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["purchase-orders"] as const;

export function usePurchaseOrders(params: QueryParams = {}) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<PurchaseOrder>("purchase-orders", params),
    placeholderData: (prev) => prev,
  });
}

export function usePurchaseOrder(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<PurchaseOrder>(`purchase-orders/${id}`),
    enabled: !!id,
  });
}

export function useCreatePO() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePOInput) => api.post<PurchaseOrder>("purchase-orders", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdatePO(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdatePOInput) => api.patch<PurchaseOrder>(`purchase-orders/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

function usePOAction(action: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<PurchaseOrder>(`purchase-orders/${id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

export const useSendPO = (id: string) => usePOAction("send", id);
export const useReceivePO = (id: string) => usePOAction("receive", id);
export const useCancelPO = (id: string) => usePOAction("cancel", id);

export function useConvertPOToBill(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ billId: string; billNumber: string }>(`purchase-orders/${id}/convert-to-bill`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
      qc.invalidateQueries({ queryKey: ["bills"] });
    },
  });
}
