"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateDepartmentInput, Department, UpdateDepartmentInput } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["departments"] as const;

export function useDepartments(params: QueryParams) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Department>("departments", params),
    placeholderData: (prev) => prev,
  });
}

/** All departments (unpaginated) for pickers/filters. */
export function useAllDepartments() {
  return useQuery({
    queryKey: [...KEY, "all"],
    queryFn: () => api.get<Department[]>("departments/all"),
  });
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: KEY });
}

export function useCreateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateDepartmentInput) => api.post<Department>("departments", input),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdateDepartment() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, input }: { id: string; input: UpdateDepartmentInput }) =>
      api.patch<Department>(`departments/${id}`, input),
    onSuccess: () => invalidate(qc),
  });
}

export function useDeleteDepartment() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<void>(`departments/${id}`),
    onSuccess: (qcResult, _id) => {
      invalidate(qc);
      // Users/customers may have lost their department assignment.
      qc.invalidateQueries({ queryKey: ["users"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}
