"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  ConvertQuotationInput,
  ConvertToInvoiceInput,
  CreateQuotationInput,
  Quotation,
  SalesOrder,
  UpdateQuotationInput,
} from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["quotations"] as const;

export function useQuotations(params: QueryParams) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Quotation>("quotations", params),
    placeholderData: (prev) => prev,
  });
}

export function useQuotation(id: string | undefined) {
  return useQuery({
    queryKey: ["quotation", id],
    queryFn: () => api.get<Quotation>(`quotations/${id}`),
    enabled: !!id,
  });
}

export function useCreateQuotation() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateQuotationInput) => api.post<Quotation>("quotations", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateQuotation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateQuotationInput) =>
      api.patch<Quotation>(`quotations/${id}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["quotation", id] });
    },
  });
}

export function useDeleteQuotation() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<void>(`quotations/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Status transition + convert actions, keyed by quote id. */
function useAction<T>(path: (id: string) => string, body?: unknown) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.post<T>(path(id), body),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["quotation", id] });
    },
  });
}

export const useSendQuotation = () => useAction<Quotation>((id) => `quotations/${id}/send`);
export const useAcceptQuotation = () => useAction<Quotation>((id) => `quotations/${id}/accept`);
export const useDeclineQuotation = () => useAction<Quotation>((id) => `quotations/${id}/decline`);

export function useConvertQuotation() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, input }: { id: string; input: ConvertQuotationInput }) =>
      api.post<{ quotation: Quotation; salesOrder: SalesOrder }>(
        `quotations/${id}/convert`,
        input,
      ),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["quotation", id] });
      qc.invalidateQueries({ queryKey: ["sales-orders"] });
    },
  });
}

export function useConvertToInvoice() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, input }: { id: string; input: ConvertToInvoiceInput }) =>
      api.post<{ quotation: Quotation; invoice: { id: string; invoiceNumber: string } }>(
        `quotations/${id}/convert-invoice`,
        input,
      ),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["quotation", id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}
