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
import { api } from "@/lib/api";

const KEY = ["loans"] as const;

interface LoansResult {
  data: Loan[];
  meta: { total: number; page: number; pageSize: number; pageCount: number };
}

// ── Loans ─────────────────────────────────────────────────────────────────────

export function useLoans(params: Partial<LoanQuery> = {}) {
  const qs = new URLSearchParams();
  if (params.type) qs.set("type", params.type);
  if (params.status) qs.set("status", params.status);
  if (params.page) qs.set("page", String(params.page));
  if (params.pageSize) qs.set("pageSize", String(params.pageSize));
  return useQuery({
    queryKey: [...KEY, "list", params],
    queryFn: () => api.get<LoansResult>(`loans?${qs.toString()}`),
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
