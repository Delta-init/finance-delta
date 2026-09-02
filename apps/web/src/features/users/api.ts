"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CreateUserInput, UpdateUserInput, User } from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["users"] as const;

export function useUsers(params: QueryParams, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<User>("users", params),
    placeholderData: (prev) => prev,
    // Only honoured when given, so existing callers are unaffected. Reading
    // users needs user:read, which somebody scoped to their own records does
    // not have — without this they fire a request that can only be refused.
    ...(options?.enabled === undefined ? {} : { enabled: options.enabled }),
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

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, input }: { id: string; input: UpdateUserInput }) =>
      api.patch<User>(`users/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Removes them from this organization. Refused while their name is on a document. */
export function useRemoveUser() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<void>(`users/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * Names of the people in this organization, for a picker.
 *
 * Separate from `useUsers` because that needs `user:read`, which a counsellor
 * does not hold — this returns names and ids only, and is open to anybody who
 * can raise an invoice.
 */
export function useColleagues() {
  return useQuery({
    queryKey: [...KEY, "colleagues"],
    queryFn: () => api.get<{ id: string; name: string }[]>("users/colleagues"),
    staleTime: 5 * 60_000,
  });
}
