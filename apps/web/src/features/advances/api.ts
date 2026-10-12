"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApproveAdvanceBody, RejectAdvanceBody } from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["advances"] as const;

/** A salary advance HR has approved in HRMS, waiting on finance. */
export interface SalaryAdvanceRequest {
  _id: string;
  hrmsOrgId: string;
  /** Major units, as HR approved it. */
  amount: number;
  currency: string;
  reason: string;
  neededBy?: string | null;
  monthlySalary: number;
  months: number;
  startMonth: string;
  employee?: { _id: string; name: string; employeeCode?: string; designation?: string; department?: { _id: string; name: string } | null } | null;
  hrReviewedBy?: { _id: string; name: string } | null;
  hrNote?: string;
  createdAt: string;
  suggestedDepartmentId: string | null;
  expense: { id: string; expenseNumber: string; status: string } | null;
}

export interface AdvanceApproval {
  expense: { id: string; expenseNumber: string; totalMinor: number; currency: string };
}

/** Read live from HRMS on every load, like procurement. */
export function useSalaryAdvances() {
  return useQuery({
    queryKey: [...KEY, "waiting"],
    queryFn: () => api.get<SalaryAdvanceRequest[]>("advances"),
    retry: false,
  });
}

export function useApproveAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: ApproveAdvanceBody & { id: string }) =>
      api.post<AdvanceApproval>(`advances/${id}/approve`, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["expenses"] });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}

export function useRejectAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: RejectAdvanceBody & { id: string }) =>
      api.post<{ rejected: true }>(`advances/${id}/reject`, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}
