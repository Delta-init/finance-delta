"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";

const KEY = ["procurement"] as const;

/** A purchase request HR has approved and passed to finance. */
export interface ProcurementRequest {
  _id: string;
  hrmsOrgId: string;
  item: string;
  category?: string;
  quantity: number;
  /** Major units, as HR entered it. */
  estimatedCost: number;
  currency: string;
  vendor?: string;
  justification?: string;
  neededBy?: string | null;
  resubmitCount: number;
  department?: { _id: string; name: string } | null;
  requestedBy?: { _id: string; name: string; email?: string } | null;
  hrNote?: string;
  createdAt: string;
}

/**
 * Read live from HRMS on every load, never cached across a decision — two
 * people approving the same request is exactly what a stale list causes.
 */
export function useProcurementRequests() {
  return useQuery({
    queryKey: [...KEY, "waiting"],
    queryFn: () => api.get<ProcurementRequest[]>("procurement"),
    retry: false,
  });
}

export function useApproveProcurement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; hrmsOrgId: string; vendorId: string; note?: string }) =>
      api.post<{ purchaseOrder: { poNumber: string } }>(`procurement/${v.id}/approve`, {
        hrmsOrgId: v.hrmsOrgId, vendorId: v.vendorId, note: v.note,
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRejectProcurement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; hrmsOrgId: string; note?: string }) =>
      api.post(`procurement/${v.id}/reject`, { hrmsOrgId: v.hrmsOrgId, note: v.note }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}
