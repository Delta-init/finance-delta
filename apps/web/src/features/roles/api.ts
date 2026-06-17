"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CreateRoleInput, Role } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["roles"] as const;

export function useRoles(params: QueryParams) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Role>("roles", params),
    placeholderData: (prev) => prev,
  });
}

export function useCreateRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRoleInput) => api.post<Role>("roles", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`roles/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
