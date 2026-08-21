"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export type SuggestionField = "lineDescription" | "reference" | "notes" | "terms";

/** Fetches distinct previously-entered values for a field (org-scoped), for
 *  type-ahead. Enable only while the input is focused to avoid idle requests. */
export function useSuggestions(field: SuggestionField, q: string, enabled: boolean) {
  const query = q.trim();
  return useQuery({
    queryKey: ["suggestions", field, query],
    queryFn: () =>
      api.get<string[]>(`suggestions?field=${field}&q=${encodeURIComponent(query)}`),
    enabled,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });
}

export type SuggestionSource = "invoice" | "quotation" | "bill" | "purchase_order" | "credit_note";

/** The single most-recently-entered value for a field on a given document type
 *  — used to pre-fill Notes/Terms on a brand-new document from the same kind of
 *  document. Returns "" when there's no history. */
export function useRecentSuggestion(field: SuggestionField, from: SuggestionSource, enabled: boolean) {
  return useQuery({
    queryKey: ["suggestions-recent", field, from],
    queryFn: () => api.get<string>(`suggestions?field=${field}&recent=1&from=${from}`),
    enabled,
    staleTime: 60_000,
  });
}
