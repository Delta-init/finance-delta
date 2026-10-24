"use client";

import { Wallet } from "lucide-react";
import { AnalysisReportView, type AnalysisConfig } from "@/features/reports/AnalysisReport";

/** Every expense of the period — by category, employee, department and more, with a filter for each (2026-10-24). */
const CONFIG: AnalysisConfig = {
  kind: "expense",
  title: "Expense report",
  description: "Approved and waiting expenses — by category, employee, department, payment method, bank account and more.",
  icon: Wallet,
  bases: [{ key: "expense", label: "Expense date" }, { key: "paid", label: "Paid date" }],
  groupBys: ["category", "subcategory", "employee", "department", "submittedBy", "method", "bank", "source", "status", "paid", "month"],
  filters: ["category", "subcategory", "employee", "department", "submittedBy", "method", "bank", "source", "status", "paid"],
  pnl: true,
  cards: (r) => [
    { label: "Total expenses", minor: r.totals.amountMinor, hint: `${r.totals.count.toLocaleString()} expense${r.totals.count === 1 ? "" : "s"}` },
    { label: "Paid", minor: r.totals.paidMinor, tone: "text-success" },
    { label: "Not paid yet", minor: r.totals.unpaidMinor, tone: (r.totals.unpaidMinor ?? 0) > 0 ? "text-warning" : undefined },
    { label: "Average", minor: r.totals.count ? Math.round(r.totals.amountMinor / r.totals.count) : 0, hint: "per expense" },
  ],
};

export default function ExpenseReportPage() {
  return <AnalysisReportView config={CONFIG} />;
}
