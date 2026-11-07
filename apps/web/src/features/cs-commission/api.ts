"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApproveCsCommissionInput, CsCommissionKind, CsCommissionPeriod, Invoice, PayCsCommissionInput, RecordCsCommissionPaymentInput, RevokeCsCommissionInput, UploadedExpenseFile } from "@delta/shared";
import { CS_COMMISSION_PERIOD } from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["cs-commission"] as const;

/** A period of the CS Portal's commission, read live from it (2026-11-03). */
export function useCsCommission(kind: CsCommissionKind, period: string) {
  return useQuery({
    queryKey: [...KEY, kind, period],
    queryFn: () => api.get<CsCommissionPeriod>(`cs-commission?kind=${kind}&period=${period}`),
    enabled: CS_COMMISSION_PERIOD[kind].test(period),
    retry: false,
  });
}

export function useApproveCsCommission() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: ApproveCsCommissionInput) => api.post<{ approved: true; alreadyReleased: boolean }>("cs-commission/approve", input),
    onSettled: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export function useRevokeCsCommission() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: RevokeCsCommissionInput) => api.post<{ revoked: true }>("cs-commission/revoke", input),
    onSettled: () => { void qc.invalidateQueries({ queryKey: KEY }); },
  });
}

export async function uploadCsCommissionReceipt(file: File): Promise<UploadedExpenseFile> {
  const form = new FormData();
  form.append("file", file);
  return api.postForm<UploadedExpenseFile>("cs-commission/uploads", form);
}

export function usePayCsCommission() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: PayCsCommissionInput) => api.post<{ expense: { id: string; expenseNumber: string } }>("cs-commission/pay", input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

/** Approve and pay in one step — before the CS Portal's approvals too, with a reason (2026-11-06). */
export function useRecordCsCommissionPayment() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: RecordCsCommissionPaymentInput) =>
      api.post<{ expense: { id: string; expenseNumber: string }; approved: boolean }>("cs-commission/record-payment", input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

/** A credit's course invoice, read-only, for the pop-up (2026-11-07). */
export function useCsCommissionInvoice(id: string | null) {
  return useQuery({
    queryKey: [...KEY, "invoice", id],
    queryFn: () => api.get<{ invoice: Invoice; orgId: string; orgName: string }>(`cs-commission/invoices/${id}`),
    enabled: !!id,
    retry: false,
  });
}
