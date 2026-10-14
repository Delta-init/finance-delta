"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ApproveHiringBody, RejectHiringBody } from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["hiring"] as const;

/** A hiring request HR approved in HRMS whose cost is not budgeted, waiting on finance (2026-10-15). */
export interface HiringRequest {
  _id: string;
  hrmsOrgId: string;
  hrmsOrgName: string;
  title: string;
  type: "replacement" | "new_headcount";
  headcount: number;
  /** Major units. */
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency: string;
  department?: { name: string } | null;
  designation?: string;
  location?: string;
  employmentType?: string;
  justification?: string;
  targetStartDate?: string | null;
  jdText?: string;
  jdFileName?: string;
  jdUrl?: string;
  raisedBy?: { name: string; email?: string } | null;
  replacing?: { name: string; designation?: string; salary?: number | null } | null;
  hrApprovedAt?: string | null;
  hrApprovedBy?: string;
  createdAt: string;
  /** Decided here, but HRMS never took the answer. */
  undelivered: { decision: "approved" | "rejected"; decidedByName: string; decidedAt: string } | null;
}

/** Read live from HRMS on every load, like salary advances. */
export function useHiringRequests() {
  return useQuery({
    queryKey: [...KEY, "waiting"],
    queryFn: () => api.get<HiringRequest[]>("hiring"),
    retry: false,
  });
}

function useDecide(decision: "approve" | "reject") {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: (ApproveHiringBody | RejectHiringBody) & { id: string }) =>
      api.post<{ decision: string; alreadyDone: boolean }>(`hiring/${id}/${decision}`, body),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["approvals"] });
    },
  });
}
export const useApproveHiring = () => useDecide("approve");
export const useRejectHiring = () => useDecide("reject");
