"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type QueryParams } from "@/lib/api";
import type {
  ApplyResult, CreatedOrgLink, HrmsOrganization, IntegrationHealth,
  MappedEmployee, OrgLink, SyncDecision, SyncPreview,
} from "./types";

const KEY = ["payroll-mapping"] as const;
const BASE = "payroll-mapping";

/**
 * Whether HRMS is configured and answering. Polled rather than fetched once:
 * the usual failure is a clock drift or a rotated secret, and both appear while
 * somebody is already on the page wondering why sync will not start.
 */
export function useIntegrationHealth() {
  return useQuery({
    queryKey: [...KEY, "health"],
    queryFn: () => api.get<IntegrationHealth>(`${BASE}/health`),
    refetchInterval: 60_000,
    retry: false,
  });
}

export function useHrmsOrganizations(enabled: boolean) {
  return useQuery({
    queryKey: [...KEY, "hrms-organizations"],
    queryFn: () => api.get<HrmsOrganization[]>(`${BASE}/hrms-organizations`),
    enabled,
    retry: false,
  });
}

export function useOrgLinks() {
  return useQuery({
    queryKey: [...KEY, "org-links"],
    queryFn: () => api.get<OrgLink[]>(`${BASE}/org-links`),
  });
}

export function useCreateOrgLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (hrmsOrgId: string) => api.post<CreatedOrgLink>(`${BASE}/org-links`, { hrmsOrgId }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useRemoveOrgLink() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del<void>(`${BASE}/org-links/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

/**
 * The proposal. Never cached across a page visit — it is a live comparison
 * against HRMS, and a stale one would have somebody confirming decisions about
 * a roster that has since changed.
 */
export function useSyncPreview(hrmsOrgId: string | null) {
  return useQuery({
    queryKey: [...KEY, "preview", hrmsOrgId],
    queryFn: () => api.get<SyncPreview>(`${BASE}/sync/preview?hrmsOrgId=${hrmsOrgId}`),
    enabled: Boolean(hrmsOrgId),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useApplySync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ hrmsOrgId, decisions }: { hrmsOrgId: string; decisions: SyncDecision[] }) =>
      api.post<ApplyResult>(`${BASE}/sync/apply`, { hrmsOrgId, decisions }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useMappedEmployees(params: QueryParams) {
  return useQuery({
    queryKey: [...KEY, "employees", params],
    queryFn: () => api.getList<MappedEmployee>(`${BASE}/employees`, params),
    placeholderData: (prev) => prev,
  });
}
