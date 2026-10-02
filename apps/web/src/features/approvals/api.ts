"use client";

import { useQuery } from "@tanstack/react-query";
import type { ApprovalRow, ApprovalSummary } from "@delta/shared";
import { api, type PageMeta, type QueryParams } from "@/lib/api";

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

/** What the list says about itself, besides the page: any kind it could not read. */
export type ApprovalListMeta = PageMeta & { unavailable?: string[] };

/**
 * Every approval the signed-in person may decide, waiting and decided, newest
 * first — the Approvals page's table.
 *
 * Under the same key as the summary, so deciding anything (each decision
 * invalidates APPROVALS_KEY) refreshes both.
 */
export function useApprovalList(params: QueryParams, enabled = true) {
  return useQuery({
    queryKey: [...APPROVALS_KEY, "list", params],
    queryFn: async () => {
      const page = await api.getList<ApprovalRow>("approvals/list", params);
      return { data: page.data, meta: page.meta as ApprovalListMeta };
    },
    placeholderData: (prev) => prev,
    enabled,
    refetchInterval: 60_000,
    // An older API has no list yet: asking again every second will not change that.
    retry: (count, err) => !(err instanceof Error && "status" in err && (err as { status: number }).status === 404) && count < 2,
  });
}
