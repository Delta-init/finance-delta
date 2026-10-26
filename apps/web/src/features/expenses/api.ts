"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateExpenseInput,
  UpdateExpenseInput,
  Expense,
  ExpenseSummary,
  RejectExpenseInput,
  RecordProcurementPaymentInput,
} from "@delta/shared";
import { api, qs, type QueryParams } from "@/lib/api";

const KEY = ["expenses"] as const;

export function useExpenses(params: QueryParams = {}, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Expense>("expenses", params),
    placeholderData: (prev) => prev,
    // Off by default is not the behaviour — `enabled` is only honoured when
    // given, so every existing caller is unaffected. It exists so a component
    // that is about to render nothing does not fetch first.
    ...(options?.enabled === undefined ? {} : { enabled: options.enabled }),
  });
}

/** The list's cards: what the same filters match, per currency (2026-10-21). No paging — the cards are the whole match. */
export function useExpenseSummary(params: QueryParams = {}) {
  const { page: _p, pageSize: _s, sort: _o, dir: _d, ...filters } = params as Record<string, unknown>;
  return useQuery({
    queryKey: [...KEY, "summary", filters],
    queryFn: () => api.get<ExpenseSummary>(`expenses/summary${qs(filters as QueryParams)}`),
    placeholderData: (prev) => prev,
    retry: false,
  });
}

export function useExpense(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<Expense>(`expenses/${id}`),
    enabled: !!id,
  });
}

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateExpenseInput) => api.post<Expense>("expenses", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateExpense(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateExpenseInput) => api.patch<Expense>(`expenses/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

function useExpenseAction(action: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (body?: unknown) =>
      body !== undefined
        ? api.post<Expense>(`expenses/${id}/${action}`, body as Record<string, unknown>)
        : api.post<Expense>(`expenses/${id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

/** Remove an expense for good (2026-10-16) — voiding keeps it on the record; this does not. */
export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<void>(`expenses/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export const useSubmitExpense = (id: string) => useExpenseAction("submit", id);
export const useApproveExpense = (id: string) => useExpenseAction("approve", id);
export const useVoidExpense = (id: string) => useExpenseAction("void", id);
export const useMarkExpensePaid = (id: string) => useExpenseAction("mark-paid", id);
export const useMarkExpenseUnpaid = (id: string) => useExpenseAction("mark-unpaid", id);
export const usePauseRecurrence = (id: string) => useExpenseAction("recurrence/pause", id);
export const useResumeRecurrence = (id: string) => useExpenseAction("recurrence/resume", id);
export const useStopRecurrence = (id: string) => useExpenseAction("recurrence/stop", id);

export function useRejectExpense(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: RejectExpenseInput) =>
      api.post<Expense>(`expenses/${id}/reject`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

export function useAddExpenseAttachment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.postForm<Expense>(`expenses/${id}/attachments`, form);
    },
    onSuccess: (data) => {
      qc.setQueryData([...KEY, id], data);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useRemoveExpenseAttachment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    // The key is a storage path with slashes in it, so it has to survive being
    // put in the URL.
    mutationFn: (key: string) =>
      api.del<Expense>(`expenses/${id}/attachments/${encodeURIComponent(key)}`),
    onSuccess: (data) => {
      qc.setQueryData([...KEY, id], data);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/** Its statement date typed in by hand, or null to take it off (2026-10-26). */
export function useSetExpenseStatementDate(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (statementDate: string | null) => api.post<Expense>(`expenses/${id}/statement-date`, { statementDate }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

/** An approved purchase request paid, its receipt already attached (2026-10-26). */
export function useRecordProcurementPayment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: RecordProcurementPaymentInput) => api.post<Expense>(`expenses/${id}/record-payment`, input),
    onSuccess: (data) => {
      qc.setQueryData([...KEY, id], data);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
