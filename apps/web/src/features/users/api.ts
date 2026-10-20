"use client";

import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { ConvertSalespersonInput, CreateCrmSalespersonInput, CreateUserInput, UpdateUserInput, User } from "@delta/shared";
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

/* ── Salespeople (2026-10-20): payroll-only accounts, CRM salespeople with none, and making either a real user ── */

export interface SalespersonRow {
  id: string; name: string; email: string; department: { id: string; name: string } | null
  status: "active" | "suspended"; invoices: number; lastSaleAt: string | null; crms: string[]
}
export interface MissingSalespersonRow {
  email: string; name: string; invoices: number; lastSaleAt: string | null; crms: string[]; elsewhere: boolean
}
export interface InviteOutcome { delivered: boolean; email: string; message: string }

export function useSalespeople(q: string) {
  return useQuery({
    queryKey: [...KEY, "salespeople", q],
    queryFn: () => api.get<{ payroll: SalespersonRow[]; missing: MissingSalespersonRow[] }>(`users/salespeople${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`),
    placeholderData: (prev) => prev,
  });
}

export function useConvertSalesperson() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, input }: { id: string; input: ConvertSalespersonInput }) =>
      api.post<{ id: string; name: string; email: string; invite: InviteOutcome | null }>(`users/${id}/convert`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCreateCrmSalesperson() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateCrmSalespersonInput) =>
      api.post<{ id: string; name: string; email: string; moved: number; invite: InviteOutcome | null }>("users/salespeople", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** An email with a link to set their own password (POST /users/:id/invite). */
export function useInviteUser() {
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.post<InviteOutcome>(`users/${id}/invite`, {}),
  });
}
