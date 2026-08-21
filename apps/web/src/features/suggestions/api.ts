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
