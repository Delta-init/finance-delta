"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CourseChange, DecideCourseChangeInput } from "@delta/shared";
import { api } from "@/lib/api";
import { APPROVALS_KEY } from "@/features/approvals/api";

/** A course change from a sales CRM (2026-11-23), as the Approvals page reviews it. */
const KEY = ["course-changes"] as const;

export function useCourseChange(id: string | null) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<CourseChange>(`course-changes/${id}`),
    enabled: !!id,
  });
}

export function useDecideCourseChange(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecideCourseChangeInput) => api.post<CourseChange>(`course-changes/${id}/decision`, input),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: KEY });
      // What is waiting changed: the sidebar counts, the pop-up and the table read that.
      qc.invalidateQueries({ queryKey: APPROVALS_KEY });
    },
  });
}
