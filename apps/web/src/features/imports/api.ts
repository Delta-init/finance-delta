"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ImportPreview, ImportResult } from "@delta/shared";
import { api } from "@/lib/api";

/** Which import: its routes, and the lists to refresh once it has made something. */
export type ImportResource = "expenses" | "bills";

const REFRESH: Record<ImportResource, string[][]> = {
  expenses: [["expenses"]],
  // A bill makes its own expense, and the import may add vendors.
  bills: [["bills"], ["expenses"], ["vendors"]],
};

/** POST /{resource}/import/preview — writes nothing. */
export function useImportPreview(resource: ImportResource) {
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (body: Record<string, unknown>) => api.post<ImportPreview>(`${resource}/import/preview`, body),
  });
}

/** POST /{resource}/import — one part of the file at a time. */
export function useImportRun(resource: ImportResource) {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (body: Record<string, unknown>) => api.post<ImportResult>(`${resource}/import`, body),
    onSettled: () => {
      for (const key of REFRESH[resource]) void qc.invalidateQueries({ queryKey: key });
    },
  });
}
