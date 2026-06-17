"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreditNote, CreateCreditNoteInput, ApplyCreditNoteInput } from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["credit-notes"] as const;

export function useCreditNotes() {
  return useQuery({ queryKey: KEY, queryFn: () => api.get<CreditNote[]>("credit-notes") });
}

export function useCreditNote(id: string) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<CreditNote>(`credit-notes/${id}`),
    enabled: !!id,
  });
}

export function useCreateCreditNote() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateCreditNoteInput) => api.post<CreditNote>("credit-notes", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

function useAction(path: (id: string) => string, body?: object) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.post<CreditNote>(path(id), body),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

export const useIssueCreditNote = () => useAction((id) => `credit-notes/${id}/issue`);
export const useVoidCreditNote = () => useAction((id) => `credit-notes/${id}/void`);

export function useApplyCreditNote() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, input }: { id: string; input: ApplyCreditNoteInput }) =>
      api.post<CreditNote>(`credit-notes/${id}/apply`, input),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}
