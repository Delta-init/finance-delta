"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrganizationSettings, UpdateOrganizationInput } from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["organization"] as const;

export function useOrganization() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<OrganizationSettings>("organizations/settings"),
  });
}

export function useUpdateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateOrganizationInput) =>
      api.patch<OrganizationSettings>("organizations/settings", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
