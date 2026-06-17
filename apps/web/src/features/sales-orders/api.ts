"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SalesOrder } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["sales-orders"] as const;

export function useSalesOrders(params: QueryParams) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<SalesOrder>("sales-orders", params),
    placeholderData: (prev) => prev,
  });
}

export function useSalesOrder(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<SalesOrder>(`sales-orders/${id}`),
    enabled: !!id,
  });
}

export function useCancelSalesOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<SalesOrder>(`sales-orders/${id}/cancel`),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}
