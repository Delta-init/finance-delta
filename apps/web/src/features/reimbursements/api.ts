"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PayReimbursementBody, RejectReimbursementBody } from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["reimbursements"] as const;

/** An employee's reimbursement claim HR approved in HRMS, for finance to pay (2026-11-16). */
export interface ReimbursementClaim {
  _id: string;
  hrmsOrgId: string;
  title: string;
  /** HRMS's category: travel, food, accommodation, medical, communication, fuel, supplies, other. */
  category: string;
  /** Major units: as claimed — or, once finance paid a different amount, what was paid. */
  amount: number;
  /** What was claimed, when finance paid a different amount; null when as claimed. Absent from an older HRMS. */
  requestedAmount?: number | null;
  currency: string;
  expenseDate: string | null;
  month: string;
  description: string;
  receiptUrl: string;
  status: "hr_approved" | "paid" | "rejected";
  employee: { _id: string; name: string; employeeCode: string; designation: string; department: { _id: string; name: string } | null } | null;
  user: { name: string; email: string } | null;
  hrReviewedBy: { name: string } | null;
  hrReviewedAt: string | null;
  hrNote: string;
  createdAt: string;
  rejectedBy: "hr" | "finance" | null;
  financeRef: string;
  paidOn: string | null;
  paymentMethod: string;
  financeNote: string;
  financeReviewedBy: string;
  financeReviewedAt: string | null;
  /** An expense already recorded for it, when there is one. */
  expense: { id: string; expenseNumber: string; status: string } | null;
}

/** A waiting claim, with what the page suggests for booking it. */
export interface WaitingClaim extends ReimbursementClaim {
  suggestedDepartmentId: string | null;
  suggestedSubcategory: string;
}

/** Which part of finance's record a tab shows. */
export type ReimbursementHistoryStatus = "paid" | "rejected" | "all";

/** Read live from HRMS on every load. */
export function useReimbursements() {
  return useQuery({
    queryKey: [...KEY, "waiting"],
    queryFn: () => api.get<WaitingClaim[]>("reimbursements"),
    retry: false,
  });
}

/** Paid, refused, or every claim that reached finance — newest first, read live from HRMS. */
export function useReimbursementHistory(status: ReimbursementHistoryStatus, enabled = true) {
  return useQuery({
    queryKey: [...KEY, "history", status],
    queryFn: () => api.get<ReimbursementClaim[]>(`reimbursements/history?status=${status}`),
    enabled,
    retry: false,
  });
}

export function usePayReimbursement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: PayReimbursementBody & { id: string }) =>
      api.post<{ expense: { id: string; expenseNumber: string; totalMinor: number; currency: string } }>(`reimbursements/${id}/pay`, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["expenses"] });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}

export function useRejectReimbursement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: RejectReimbursementBody & { id: string }) =>
      api.post<{ rejected: true }>(`reimbursements/${id}/reject`, body),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}
