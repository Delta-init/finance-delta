"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateInvoiceInput, Invoice, RecordPaymentInput, UpdateInvoiceInput } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["invoices"] as const;

export function useInvoices(params: QueryParams) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Invoice>("invoices", params),
    placeholderData: (prev) => prev,
  });
}

export function useInvoice(id: string | undefined) {
  return useQuery({
    queryKey: ["invoice", id],
    queryFn: () => api.get<Invoice>(`invoices/${id}`),
    enabled: !!id,
  });
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateInvoiceInput) => api.post<Invoice>("invoices", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateInvoice(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateInvoiceInput) => api.patch<Invoice>(`invoices/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["invoice", id] });
    },
  });
}

export function useDeleteInvoice() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<void>(`invoices/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

function useAction(path: (id: string) => string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.post<Invoice>(path(id)),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["invoice", id] });
    },
  });
}

export const useSendInvoice = () => useAction((id) => `invoices/${id}/send`);
export const useVoidInvoice = () => useAction((id) => `invoices/${id}/void`);

export function useResendInvoice() {
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, message }: { id: string; message?: string }) =>
      api.post<{ queued: boolean }>(`invoices/${id}/resend`, { message }),
  });
}

export function useRecordPayment(invoiceId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ input, file }: { input: RecordPaymentInput; file?: File }) => {
      if (file) {
        const form = new FormData();
        form.append("data", JSON.stringify(input));
        form.append("file", file);
        return api.postForm<Invoice>(`invoices/${invoiceId}/payments`, form);
      }
      return api.post<Invoice>(`invoices/${invoiceId}/payments`, input);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    },
  });
}

export function useUpdatePayment(invoiceId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ paymentId, input }: { paymentId: string; input: RecordPaymentInput }) =>
      api.patch<Invoice>(`invoices/${invoiceId}/payments/${paymentId}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
    },
  });
}

export function useApproveInvoice(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: () => api.post<Invoice>(`invoices/${id}/approval/approve`, {}),
    onSuccess: (d) => {
      qc.setQueryData(["invoice", id], d);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useReturnInvoice(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (reason: string) => api.post<Invoice>(`invoices/${id}/approval/return`, { reason }),
    onSuccess: (d) => {
      qc.setQueryData(["invoice", id], d);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useResubmitInvoice(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: () => api.post<Invoice>(`invoices/${id}/approval/resubmit`, {}),
    onSuccess: (d) => {
      qc.setQueryData(["invoice", id], d);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
