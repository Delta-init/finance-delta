"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateOrganizationInput, InviteMemberInput } from "@delta/shared";
import { api } from "@/lib/api";

export interface OrgListItem {
  id: string;
  name: string;
  legalName: string;
  baseCurrency: string;
  memberCount: number;
  createdAt: string;
}

export interface MemberListItem {
  id: string;
  name: string;
  email: string;
  roleKey: string;
  roleName: string;
  status: string;
  memberStatus: string;
}

export interface OrgRoleItem { id: string; key: string; name: string }

export function usePlatformOrgs() {
  return useQuery({
    queryKey: ["platform", "organizations"],
    queryFn: () => api.get<OrgListItem[]>("platform/organizations"),
  });
}

export function useCreateOrg() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrganizationInput) =>
      api.post<OrgListItem>("platform/organizations", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["platform", "organizations"] }),
  });
}

export function usePlatformMembers(orgId: string) {
  return useQuery({
    queryKey: ["platform", "members", orgId],
    queryFn: () => api.get<MemberListItem[]>(`platform/organizations/${orgId}/members`),
    enabled: !!orgId,
  });
}

export function useOrgRoles(orgId: string) {
  return useQuery({
    queryKey: ["platform", "roles", orgId],
    queryFn: () => api.get<OrgRoleItem[]>(`platform/organizations/${orgId}/roles`),
    enabled: !!orgId,
  });
}

export function useInviteMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InviteMemberInput) =>
      api.post<MemberListItem>(`platform/organizations/${orgId}/members`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["platform", "members", orgId] }),
  });
}

export function useRemoveMember(orgId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) =>
      api.del(`platform/organizations/${orgId}/members/${userId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["platform", "members", orgId] }),
  });
}
