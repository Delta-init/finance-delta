"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CreateUserInput, User } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["users"] as const;

export function useUsers(params: QueryParams) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<User>("users", params),
    placeholderData: (prev) => prev,
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateUserInput) => api.post<User>("users", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
