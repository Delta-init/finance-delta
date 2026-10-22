"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LateEntry, LateEntryMe } from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["late-entries"] as const;

/**
 * Whether the reader decides late entries, reads them (all, or only their own — 2026-10-20), how many wait, and
 * the organization's days (2026-10-17). An older API answers isManager only: then only managers read them.
 */
export function useLateEntriesMe() {
  return useQuery({
    queryKey: [...KEY, "me"],
    queryFn: () => api.get<LateEntryMe>("late-entries/me"),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
}

export function useLateEntries(state: "pending" | "decided" | "all", enabled = true) {
  return useQuery({
    queryKey: [...KEY, state],
    queryFn: () => api.get<LateEntry[]>(`late-entries?state=${state}`),
    enabled,
  });
}

/** One entry with a date of its own before the day it was typed — Root's Pending → Finance list (2026-10-21). */
export interface OldDateRow {
  kind: "payment" | "bill_payment" | "expense" | "bill" | "invoice" | "bank_line";
  id: string; number: string; title: string;
  /** Its own date, and when it was typed in. */
  date: string; enteredAt: string; daysBack: number;
  amountMinor: number; currency: string; enteredBy: string;
  /** Typed in finance, recorded when an approval went through, or brought from HRMS. */
  origin: "typed" | "approval" | "hrms";
  late?: { state: string; reason: string; decidedBy?: string; note?: string };
  href: string;
  /** Which organization it is in (2026-10-21: every organization the reader reads). */
  orgId: string; orgName: string;
}
export interface OldDates {
  rules: { minDays: number; withinDays: number; lateEntryDays: number };
  /** Absent from an API before 2026-10-21's "all organizations": then it is the current one only. */
  currentOrgId?: string;
  organizations?: Array<{ id: string; name: string; count: number }>;
  counts: { typed: number; approval: number; hrms: number; all: number };
  rows: OldDateRow[];
}

export function useOldDateEntries(enabled = true) {
  return useQuery({
    queryKey: [...KEY, "old-dates"],
    queryFn: () => api.get<OldDates>("late-entries/old-dates"),
    enabled,
    retry: false,
  });
}

/**
 * Reads the late entries page: managers only — tagged Manager, or a super admin (the user, 2026-10-22: "late entries
 * only show for the managers"; from 2026-10-20 whoever saw expenses or bills read them too).
 */
export const canViewLate = (me: { isManager: boolean } | undefined) => Boolean(me?.isManager);

export function useDecideLateEntry() {
  const qc = useQueryClient();
  return useMutation({
    meta: { skipToast: true },
    mutationFn: ({ id, decision, note }: { id: string; decision: "approve" | "reject"; note: string }) =>
      api.post<LateEntry>(`late-entries/${id}/${decision}`, { note }),
    onSuccess: () => {
      // The record it was about changed too: an expense, a bill, a payment, its bank line.
      qc.invalidateQueries({ queryKey: KEY });
      for (const k of ["expenses", "bills", "invoices", "invoice", "payments"]) qc.invalidateQueries({ queryKey: [k] });
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0] ?? "").startsWith("bank") });
    },
  });
}
