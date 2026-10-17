"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LateEntry, LateEntryMe } from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["late-entries"] as const;

/** Whether the reader decides late entries, how many wait, and the organization's days (2026-10-17). */
export function useLateEntriesMe() {
  return useQuery({
    queryKey: [...KEY, "me"],
    queryFn: () => api.get<LateEntryMe>("late-entries/me"),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

export function useLateEntries(state: "pending" | "decided", enabled = true) {
  return useQuery({
    queryKey: [...KEY, state],
    queryFn: () => api.get<LateEntry[]>(`late-entries?state=${state}`),
    enabled,
  });
}

export function useDecideLateEntry() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, decision, note }: { id: string; decision: "approve" | "reject"; note: string }) =>
      api.post<LateEntry>(`late-entries/${id}/${decision}`, { note }),
    onSuccess: () => {
      // The record it was about changed too: an expense, a bill, a payment, its bank line.
      qc.invalidateQueries({ queryKey: KEY });
      for (const k of ["expenses", "bills", "invoices", "invoice", "payments"]) qc.invalidateQueries({ queryKey: [k] });
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("bank") });
    },
  });
}
