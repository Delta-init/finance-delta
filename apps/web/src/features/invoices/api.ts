"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateInvoiceInput,
  Invoice,
  InvoiceSummary,
  RecordPaymentInput,
  UpdateInvoiceInput,
} from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["invoices"] as const;

export function useInvoices(params: QueryParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Invoice>("invoices", params),
    placeholderData: (prev) => prev,
    enabled: options?.enabled ?? true,
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
      // A new payment belongs in the payments list straight away, for the same
      // reason an edited one does.
      qc.invalidateQueries({ queryKey: ["payments"] });
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
      // The payments list and a payment's own page read their own queries.
      // Without this an edit saved correctly and the page went on showing the
      // old figure until it was reloaded by hand.
      qc.invalidateQueries({ queryKey: ["payments"] });
    },
  });
}

export function useDeletePayment(invoiceId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (paymentId: string) =>
      api.del<Invoice>(`invoices/${invoiceId}/payments/${paymentId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["invoice", invoiceId] });
      // The payments list and the standalone payment page read their own
      // queries, and a payment that has just gone must not still be sitting in
      // either of them.
      qc.invalidateQueries({ queryKey: ["payments"] });
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

/** What this person is owed and what is waiting on them. Scoped by the server. */
export function useInvoiceSummary(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...KEY, "summary"],
    queryFn: () => api.get<InvoiceSummary>("invoices/summary"),
    enabled: options?.enabled ?? true,
  });
}

export function useAddInvoiceAttachment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.postForm<Invoice>(`invoices/${id}/attachments`, form);
    },
    onSuccess: (data) => {
      qc.setQueryData(["invoice", id], data);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

export function useRemoveInvoiceAttachment(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    // The key is a storage path with slashes in it, so it has to survive being
    // put in the URL.
    mutationFn: (key: string) =>
      api.del<Invoice>(`invoices/${id}/attachments/${encodeURIComponent(key)}`),
    onSuccess: (data) => {
      qc.setQueryData(["invoice", id], data);
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
