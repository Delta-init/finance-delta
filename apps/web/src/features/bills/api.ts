"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateBillInput, UpdateBillInput, Bill, RecordBillPaymentInput } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["bills"] as const;

export function useBills(params: QueryParams = {}, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Bill>("bills", params),
    placeholderData: (prev) => prev,
    // Honoured only when given, so every existing caller is unaffected. It
    // exists so a dialog can hold the hook without fetching until it is open.
    enabled: options?.enabled ?? true,
  });
}

export function useBill(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<Bill>(`bills/${id}`),
    enabled: !!id,
  });
}

export function useCreateBill() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateBillInput) => api.post<Bill>("bills", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateBill(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateBillInput) => api.patch<Bill>(`bills/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

function useBillAction(action: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (body?: unknown) =>
      body !== undefined
        ? api.post<Bill>(`bills/${id}/${action}`, body as Record<string, unknown>)
        : api.post<Bill>(`bills/${id}/${action}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
    },
  });
}

/**
 * Deleting a bill, which is not the same as voiding one.
 *
 * The id is an argument rather than something the hook is built around,
 * because a bulk delete needs one mutation used many times and hooks cannot be
 * called in a loop.
 */
export function useDeleteBill() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<void>(`bills/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export const useApproveBill = (id: string) => useBillAction("approve", id);
export const useRejectBill = (id: string) => useBillAction("reject", id);
export const useVoidBill = (id: string) => useBillAction("void", id);

export function useRecordBillPayment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: RecordBillPaymentInput) => api.post<Bill>(`bills/${id}/payments`, input),
    onSuccess: (data) => {
      qc.setQueryData([...KEY, id], data);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useUpdateBillPayment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ paymentId, input }: { paymentId: string; input: RecordBillPaymentInput }) =>
      api.patch<Bill>(`bills/${id}/payments/${paymentId}`, input),
    onSuccess: (data) => {
      qc.setQueryData([...KEY, id], data);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useUpdateBillNotes(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (notes: string) => api.patch<Bill>(`bills/${id}/notes`, { notes }),
    onSuccess: (data) => {
      qc.setQueryData([...KEY, id], data);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useAddBillAttachment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ file, name }: { file: File; name?: string }) => {
      const form = new FormData();
      if (name) form.append("name", name);
      form.append("file", file);
      return api.postForm<Bill>(`bills/${id}/attachments`, form);
    },
    onSuccess: (data) => {
      qc.setQueryData([...KEY, id], data);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useRemoveBillAttachment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (attId: string) => api.del<Bill>(`bills/${id}/attachments/${attId}`),
    onSuccess: (data) => {
      qc.setQueryData([...KEY, id], data);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
