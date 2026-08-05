"use client";

import { useQuery } from "@tanstack/react-query";
import type {
  ReceivedPaymentsReport,
  AgedReceivablesReport,
  InvoiceSummaryReport,
  DailyReport,
  MadePaymentsReport,
  AgedPayablesReport,
  PLReport,
  BalanceSheetReport,
  CashFlowReport,
  VATReport,
  SalesByItemReport,
  ExpenseByCategoryReport,
  CustomerStatementReport,
} from "@delta/shared";
import { api } from "@/lib/api";

const KEY = ["reports"] as const;

// ── 8.1 Receivables ───────────────────────────────────────────────────────────

export function useReceivedPayments(from: string, to: string) {
  return useQuery({
    queryKey: [...KEY, "receivables", "payments", from, to],
    queryFn: () => api.get<ReceivedPaymentsReport>(`reports/receivables/payments?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
}

export function useAgedReceivables() {
  return useQuery({
    queryKey: [...KEY, "receivables", "aged"],
    queryFn: () => api.get<AgedReceivablesReport>("reports/receivables/aged"),
  });
}

export function useInvoiceSummary(
  from: string,
  to: string,
  groupBy: "salesperson" | "customer" | "tag" | "department",
) {
  return useQuery({
    queryKey: [...KEY, "receivables", "summary", from, to, groupBy],
    queryFn: () =>
      api.get<InvoiceSummaryReport>(
        `reports/receivables/summary?from=${from}&to=${to}&groupBy=${groupBy}`,
      ),
    enabled: !!from && !!to,
  });
}

export function useDailyReport(from: string, to: string, departmentId?: string) {
  const qs = new URLSearchParams({ from, to });
  if (departmentId) qs.set("departmentId", departmentId);
  return useQuery({
    queryKey: [...KEY, "daily", from, to, departmentId ?? ""],
    queryFn: () => api.get<DailyReport>(`reports/daily?${qs.toString()}`),
    enabled: !!from && !!to,
  });
}

// ── 8.2 Payables ──────────────────────────────────────────────────────────────

export function useMadePayments(from: string, to: string) {
  return useQuery({
    queryKey: [...KEY, "payables", "payments", from, to],
    queryFn: () => api.get<MadePaymentsReport>(`reports/payables/payments?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
}

export function useAgedPayables() {
  return useQuery({
    queryKey: [...KEY, "payables", "aged"],
    queryFn: () => api.get<AgedPayablesReport>("reports/payables/aged"),
  });
}

// ── 8.3 P&L ──────────────────────────────────────────────────────────────────

export function useProfitLoss(from: string, to: string) {
  return useQuery({
    queryKey: [...KEY, "profit-loss", from, to],
    queryFn: () => api.get<PLReport>(`reports/profit-loss?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
}

// ── 8.4 Balance Sheet ─────────────────────────────────────────────────────────

export function useBalanceSheet(asOf: string) {
  return useQuery({
    queryKey: [...KEY, "balance-sheet", asOf],
    queryFn: () => api.get<BalanceSheetReport>(`reports/balance-sheet?asOf=${asOf}`),
    enabled: !!asOf,
  });
}

// ── 8.5 Cash Flow ─────────────────────────────────────────────────────────────

export function useCashFlow(from: string, to: string) {
  return useQuery({
    queryKey: [...KEY, "cash-flow", from, to],
    queryFn: () => api.get<CashFlowReport>(`reports/cash-flow?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
}

// ── 8.6 Tax ───────────────────────────────────────────────────────────────────

export function useVATReport(from: string, to: string) {
  return useQuery({
    queryKey: [...KEY, "tax", "vat", from, to],
    queryFn: () => api.get<VATReport>(`reports/tax/vat?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
}

// ── 8.7 Other ─────────────────────────────────────────────────────────────────

export function useSalesByItem(from: string, to: string) {
  return useQuery({
    queryKey: [...KEY, "sales-by-item", from, to],
    queryFn: () => api.get<SalesByItemReport>(`reports/sales-by-item?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
}

export function useExpenseByCategory(from: string, to: string) {
  return useQuery({
    queryKey: [...KEY, "expense-by-category", from, to],
    queryFn: () =>
      api.get<ExpenseByCategoryReport>(`reports/expense-by-category?from=${from}&to=${to}`),
    enabled: !!from && !!to,
  });
}

export function useCustomerStatement(
  customerId: string,
  from: string,
  to: string,
) {
  return useQuery({
    queryKey: [...KEY, "customer-statement", customerId, from, to],
    queryFn: () =>
      api.get<CustomerStatementReport>(
        `reports/customer-statement/${customerId}?from=${from}&to=${to}`,
      ),
    enabled: !!customerId && !!from && !!to,
  });
}
