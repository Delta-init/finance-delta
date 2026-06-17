"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateVendorInput, UpdateVendorInput, Vendor } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["vendors"] as const;

export function useVendors(params: QueryParams = {}) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Vendor>("vendors", params),
    placeholderData: (prev) => prev,
  });
}

export function useVendor(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<Vendor>(`vendors/${id}`),
    enabled: !!id,
  });
}

export function useCreateVendor() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateVendorInput) => api.post<Vendor>("vendors", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateVendor() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, input }: { id: string; input: UpdateVendorInput }) =>
      api.patch<Vendor>(`vendors/${id}`, input),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

export function useDeleteVendor() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<void>(`vendors/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
