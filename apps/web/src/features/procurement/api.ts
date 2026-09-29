"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApproveProcurementBody, RejectProcurementBody } from "@delta/shared";
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
  /** The finance department HR's department is linked to, when it is. */
  suggestedDepartmentId: string | null;
  /** An expense already recorded for it whose approval HR has not received yet. */
  expense: { id: string; expenseNumber: string; status: string } | null;
}

export interface ProcurementApproval {
  expense: { id: string; expenseNumber: string; totalMinor: number; currency: string };
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
    mutationFn: ({ id, ...body }: ApproveProcurementBody & { id: string }) =>
      api.post<ProcurementApproval>(`procurement/${id}/approve`, body),
    // An approval that failed half-way leaves an expense behind: the list must show it either way.
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["expenses"] });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}

export function useRejectProcurement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: RejectProcurementBody & { id: string }) =>
      api.post<{ rejected: true }>(`procurement/${id}/reject`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}
