"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MarkOneTimePaidBody, RejectOneTimePaymentBody } from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["one-time-payments"] as const;

/** A one-time payment HR sent from HRMS for finance to pay directly. */
export interface OneTimePaymentRequest {
  _id: string;
  hrmsOrgId: string;
  label: string;
  /** Major units, as HR entered it. */
  amount: number;
  month: string;
  notes?: string;
  employee?: { _id: string; name: string; employeeCode?: string; designation?: string; currency?: string; department?: { _id: string; name: string } | null } | null;
  createdBy?: { _id: string; name: string } | null;
  createdAt: string;
  suggestedDepartmentId: string | null;
  expense: { id: string; expenseNumber: string; status: string } | null;
}

/** Read live from HRMS on every load. */
export function useOneTimePayments() {
  return useQuery({
    queryKey: [...KEY, "waiting"],
    queryFn: () => api.get<OneTimePaymentRequest[]>("one-time-payments"),
    retry: false,
  });
}

export function useMarkOneTimePaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: MarkOneTimePaidBody & { id: string }) =>
      api.post<{ expense: { id: string; expenseNumber: string; totalMinor: number; currency: string } }>(`one-time-payments/${id}/paid`, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

export function useRejectOneTimePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: RejectOneTimePaymentBody & { id: string }) =>
      api.post<{ rejected: true }>(`one-time-payments/${id}/reject`, body),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}
