"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Loan,
  LoanRepayment,
  LoanSummaryReport,
  CreateLoanInput,
  UpdateLoanInput,
  RecordRepaymentInput,
  LoanQuery,
} from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["loans"] as const;

// ── Loans ─────────────────────────────────────────────────────────────────────

export function useLoans(params: Partial<LoanQuery> = {}) {
  return useQuery({
    queryKey: [...KEY, "list", params],
    // getList preserves the { data, meta } envelope; api.get would unwrap it to
    // the bare array and break `activeData.data` on the loans page.
    queryFn: () =>
      api.getList<Loan>("loans", {
        type: params.type,
        status: params.status,
        page: params.page,
        pageSize: params.pageSize,
      } as QueryParams),
  });
}

export function useLoan(id: string) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<Loan>(`loans/${id}`),
    enabled: !!id,
  });
}

export function useCreateLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateLoanInput) => api.post<Loan>("loans", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateLoanInput }) =>
      api.patch<Loan>(`loans/${id}`, input),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

export function useDeleteLoan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`loans/${id}`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, "report"] });
      qc.removeQueries({ queryKey: [...KEY, id] });
    },
  });
}

// ── Repayments ────────────────────────────────────────────────────────────────

export function useRepayments(loanId: string) {
  return useQuery({
    queryKey: [...KEY, loanId, "repayments"],
    queryFn: () => api.get<LoanRepayment[]>(`loans/${loanId}/repayments`),
    enabled: !!loanId,
  });
}

export function useRecordRepayment(loanId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RecordRepaymentInput) =>
      api.post<LoanRepayment>(`loans/${loanId}/repayments`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, loanId] });
      qc.invalidateQueries({ queryKey: [...KEY, loanId, "repayments"] });
    },
  });
}

export function useDeleteRepayment(loanId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (repaymentId: string) =>
      api.del<void>(`loans/${loanId}/repayments/${repaymentId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, loanId] });
      qc.invalidateQueries({ queryKey: [...KEY, loanId, "repayments"] });
    },
  });
}

// ── Report ────────────────────────────────────────────────────────────────────

export function useLoanReport() {
  return useQuery({
    queryKey: [...KEY, "report"],
    queryFn: () => api.get<LoanSummaryReport>("loans/report"),
  });
}
