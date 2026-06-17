"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateCustomerInput,
  Customer,
  UpdateCustomerInput,
} from "@delta/shared";
import { api, type QueryParams } from "@/lib/api";

const KEY = ["customers"] as const;

export function useCustomers(params: QueryParams) {
  return useQuery({
    queryKey: [...KEY, params],
    queryFn: () => api.getList<Customer>("customers", params),
    placeholderData: (prev) => prev,
  });
}

export function useCustomer(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api.get<Customer>(`customers/${id}`),
    enabled: !!id,
  });
}

export interface CustomerStatementRow {
  id: string;
  type: "invoice";
  number: string;
  date: string;
  dueDate: string;
  status: string;
  totalMinor: number;
  amountPaidMinor: number;
  balanceMinor: number;
  currency: string;
}

export interface CustomerStatement {
  customer: Customer;
  rows: CustomerStatementRow[];
  summary: {
    totalInvoicedMinor: number;
    totalPaidMinor: number;
    outstandingMinor: number;
    currency: string;
  };
}

export function useCustomerStatement(id: string | undefined) {
  return useQuery({
    queryKey: [...KEY, id, "statement"],
    queryFn: () => api.get<CustomerStatement>(`customers/${id}/statement`),
    enabled: !!id,
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateCustomerInput) => api.post<Customer>("customers", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, input }: { id: string; input: UpdateCustomerInput }) =>
      api.patch<Customer>(`customers/${id}`, input),
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: [...KEY, id] });
      qc.invalidateQueries({ queryKey: [...KEY, id, "statement"] });
    },
  });
}

export function useDeleteCustomer() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (id: string) => api.del<void>(`customers/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
