"use client";
import { useQuery } from "@tanstack/react-query";
import type { DashboardBreakdown, DashboardBreakdownKind } from "@delta/shared";
import { api, qs } from "@/lib/api";

export interface DashboardStats {
  currency: string;
  kpi: {
    revenueMtd: number;
    revenueLastMonth: number;
    revenueTrend: number;
    receivables: number;
    payables: number;
    /** Of payables: bills, and approved expenses not paid yet (2026-10-26). */
    payablesBills?: number;
    payablesExpenses?: number;
    netProfitMtd: number;
    netProfitLastMonth: number;
    overdueCount: number;
    overdueAmount: number;
  };
  /** This month and last, YYYY-MM in Dubai — absent from an API older than 2026-10-26. */
  months?: { current: string; last: string };
  cashflow: Array<{ month: string; key?: string; inflowMinor: number; outflowMinor: number }>;
  recentInvoices: Array<{
    id: string; number: string; customerName: string;
    status: string; dueDate: string; totalMinor: number; balanceMinor: number;
  }>;
  topCustomers: Array<{ name: string; revenueMinor: number; invoiceCount: number }>;
  expenseBreakdown: Array<{ category: string; categoryKey?: string; totalMinor: number }>;
  aging: { current: number; band1to30: number; band31to60: number; band61to90: number; band90plus: number; total: number };
}

export function useDashboardStats() {
  return useQuery<DashboardStats>({
    queryKey: ["dashboard"],
    queryFn: () => api.get<DashboardStats>("dashboard"),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
}

export interface DashboardBreakdownParams { kind: DashboardBreakdownKind; month?: string; band?: string; category?: string; customer?: string }

/** The records behind a dashboard figure (2026-10-26). */
export function useDashboardBreakdown(params: DashboardBreakdownParams | null) {
  return useQuery<DashboardBreakdown>({
    queryKey: ["dashboard", "breakdown", params],
    queryFn: () => api.get<DashboardBreakdown>(`dashboard/breakdown${qs({ ...params })}`),
    enabled: !!params,
    staleTime: 60 * 1000,
  });
}
