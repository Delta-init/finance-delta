"use client";

import { useQuery } from "@tanstack/react-query";
import type { ApprovalSummary } from "@delta/shared";
import { api } from "@/lib/api";

export const APPROVALS_KEY = ["approvals"] as const;

/**
 * What is waiting on the signed-in person, across every kind of approval.
 *
 * One query behind the sidebar counts, the dashboard pop-up and the Approvals
 * page, so they share one cache entry and cannot disagree. Refreshed every
 * minute: a request that arrives while somebody is working should show up
 * without them reloading.
 */
export function useApprovalSummary(enabled = true) {
  return useQuery({
    queryKey: [...APPROVALS_KEY, "summary"],
    queryFn: () => api.get<ApprovalSummary>("approvals/summary"),
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
