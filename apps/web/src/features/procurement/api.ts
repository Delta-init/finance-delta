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

/** Which statuses finance's full record asks for (2026-10-23). */
export type ProcurementHistoryStatus = "requested" | "hr_approved" | "approved" | "rejected" | "ordered" | "received" | "cancelled" | "all";

/** One request in finance's full record — any status or kind, with HR's and finance's decisions. */
export interface ProcurementRecord extends Omit<ProcurementRequest, "suggestedDepartmentId" | "expense"> {
  kind: "existing" | "new";
  status: Exclude<ProcurementHistoryStatus, "all">;
  hrReviewedBy?: { _id: string; name: string } | null;
  hrReviewedAt?: string | null;
  rejectedBy?: "hr" | "finance" | null;
  financeReviewedAt?: string | null;
  financeNote?: string;
  purchaseOrderRef?: string;
  notes?: string;
  reportUrl?: string;
  /** The expense finance recorded when it approved it. */
  expense: { id: string; expenseNumber: string; status: string; totalMinor: number | null } | null;
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

/** Every request from HRMS, read live like the queue (2026-10-23). */
export function useProcurementHistory(status: ProcurementHistoryStatus, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "history", status],
    queryFn: () => api.get<ProcurementRecord[]>(`procurement/history?status=${status}`),
    enabled,
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
