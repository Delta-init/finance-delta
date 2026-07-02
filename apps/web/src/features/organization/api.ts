"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { OrganizationSettings, UpdateOrganizationInput, TaxConfig, UpsertTaxConfigInput, CreateOrganizationInput } from "@delta/shared";
import { api } from "@/lib/api";

export interface OrgMembershipItem {
  id: string;
  name: string;
  baseCurrency: string;
  roleKey: string;
  roleName: string;
}

const KEY = ["organization"] as const;
const TAX_KEY = ["tax-config"] as const;

export function useOrganization() {
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<OrganizationSettings>("organizations/settings"),
  });
}

export function useUpdateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpdateOrganizationInput) =>
      api.patch<OrganizationSettings>("organizations/settings", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Returns all orgs the current user is a member of (for the org switcher). */
export function useMyOrgs() {
  return useQuery({
    queryKey: ["my-orgs"],
    queryFn: () => api.get<OrgMembershipItem[]>("organizations/mine"),
    staleTime: 5 * 60 * 1000,
  });
}

/** Create a new organization (org admins + super admin). */
export function useCreateOrganization() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: CreateOrganizationInput) =>
      api.post<OrgMembershipItem>("platform/organizations", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["my-orgs"] });
      qc.invalidateQueries({ queryKey: ["platform", "organizations"] });
    },
  });
}

export function useTaxConfig() {
  return useQuery({
    queryKey: TAX_KEY,
    queryFn: () => api.get<TaxConfig>("organizations/tax-config"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useUpsertTaxConfig() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: (input: UpsertTaxConfigInput) =>
      api.patch<TaxConfig>("organizations/tax-config", input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: TAX_KEY });
      qc.invalidateQueries({ queryKey: KEY });
    },
  });
}
