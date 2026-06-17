"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateTagInput, Tag, UpdateTagInput } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["tags"] as const;

export function useTags(params: QueryParams) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Tag>("tags", params),
    placeholderData: (prev) => prev,
  });
}

/** All tags (unpaginated) for pickers/filters. */
export function useAllTags() {
  return useQuery({
    queryKey: ["tags", "all"],
    queryFn: () => api.get<Tag[]>("tags/all"),
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: KEY });
}

export function useCreateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTagInput) => api.post<Tag>("tags", input),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTagInput }) =>
      api.patch<Tag>(`tags/${id}`, input),
    onSuccess: () => invalidate(qc),
  });
}

export function useDeleteTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`tags/${id}`),
    onSuccess: () => invalidate(qc),
  });
}
