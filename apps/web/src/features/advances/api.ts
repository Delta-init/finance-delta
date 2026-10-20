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

/** Finance's full record of advances (2026-10-20): still with HR, paid out, refused, or all. */
export type AdvanceHistoryStatus = "pending" | "approved" | "rejected" | "all";

/** One advance in finance's full record — any status, with HR's and finance's decisions. */
export interface SalaryAdvanceRecord {
  _id: string;
  hrmsOrgId: string;
  /** Major units. */
  amount: number;
  currency: string;
  reason: string;
  neededBy?: string | null;
  monthlySalary: number;
  /** "pending": still with HR; "hr_approved": waiting on finance; "approved": paid out; "rejected": refused. */
  status: "pending" | "hr_approved" | "approved" | "rejected";
  months: number | null;
  startMonth: string | null;
  employee?: { _id: string; name: string; employeeCode?: string; designation?: string; department?: { _id: string; name: string } | null } | null;
  hrReviewedBy?: { _id: string; name: string } | null;
  hrReviewedAt?: string | null;
  hrNote?: string;
  rejectedBy?: "hr" | "finance" | null;
  financeReviewedAt?: string | null;
  financeNote?: string;
  financeRef?: string;
  paidOn?: string | null;
  paymentMethod?: string;
  raisedBy?: { _id: string; name: string } | null;
  overLimit?: boolean;
  createdAt: string;
  /** The expense finance recorded when it paid it out. */
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

/** Read live from HRMS, like the queue. */
export function useAdvanceHistory(status: AdvanceHistoryStatus, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "history", status],
    queryFn: () => api.get<SalaryAdvanceRecord[]>(`advances/history?status=${status}`),
    enabled,
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
