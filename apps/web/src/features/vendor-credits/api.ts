"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateVendorCreditInput, ApplyVendorCreditInput, VendorCredit } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["vendor-credits"] as const;

export function useVendorCredits(params: QueryParams = {}) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<VendorCredit>("vendor-credits", params),
    placeholderData: (prev) => prev,
  });
}

export function useVendorCredit(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<VendorCredit>(`vendor-credits/${id}`),
    enabled: !!id,
  });
}

export function useCreateVendorCredit() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateVendorCreditInput) => api.post<VendorCredit>("vendor-credits", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useIssueVendorCredit(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: () => api.post<VendorCredit>(`vendor-credits/${id}/issue`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

export function useApplyVendorCredit(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: ApplyVendorCreditInput) => api.post<VendorCredit>(`vendor-credits/${id}/apply`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
      qc.invalidateQueries({ queryKey: ["bills"] });
    },
  });
}

export function useVoidVendorCredit(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: () => api.post<VendorCredit>(`vendor-credits/${id}/void`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}
