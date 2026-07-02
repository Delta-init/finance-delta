"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

export interface DashboardStats {
  currency: string;
  kpi: {
    revenueMtd: number;
    revenueLastMonth: number;
    revenueTrend: number;
    receivables: number;
    payables: number;
    netProfitMtd: number;
    netProfitLastMonth: number;
    overdueCount: number;
    overdueAmount: number;
  };
  cashflow: Array<{ month: string; inflowMinor: number; outflowMinor: number }>;
  recentInvoices: Array<{
    id: string; number: string; customerName: string;
    status: string; dueDate: string; totalMinor: number; balanceMinor: number;
  }>;
  topCustomers: Array<{ name: string; revenueMinor: number; invoiceCount: number }>;
  expenseBreakdown: Array<{ category: string; totalMinor: number }>;
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
