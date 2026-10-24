"use client";

import { TrendingUp } from "lucide-react";
import { AnalysisReportView, type AnalysisConfig } from "@/features/reports/AnalysisReport";

/** Revenue — invoiced (less credit notes) or collected — by salesperson, department, course and more (2026-10-24). */
const CONFIG: AnalysisConfig = {
  kind: "revenue",
  title: "Revenue report",
  description: "Invoiced less credit notes, or collected — by salesperson, department, course, customer, CRM, academy and more.",
  icon: TrendingUp,
  bases: [{ key: "invoiced", label: "Invoiced" }, { key: "collected", label: "Collected" }],
  groupBys: ["salesperson", "department", "course", "customer", "crm", "academy", "method", "bank", "status", "month"],
  filters: ["salesperson", "department", "course", "customer", "crm", "academy", "method", "bank", "status"],
  // A payment's method and bank mean nothing for an invoice.
  hidden: (basis) => (basis === "invoiced" ? ["method", "bank"] : []),
  cards: (r) => r.basis === "invoiced"
    ? [
      { label: "Revenue (net)", minor: r.totals.amountMinor, hint: `${r.totals.count.toLocaleString()} invoices and credit notes` },
      { label: "Invoiced", minor: r.totals.invoicedMinor },
      { label: "Credit notes", minor: r.totals.creditMinor ? -(r.totals.creditMinor) : 0, tone: (r.totals.creditMinor ?? 0) > 0 ? "text-danger" : undefined },
      { label: "Still owed on these", minor: r.totals.outstandingMinor, tone: (r.totals.outstandingMinor ?? 0) > 0 ? "text-warning" : undefined, hint: `collected so far ${r.currency} ${((r.totals.collectedMinor ?? 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` },
    ]
    : [
      { label: "Collected", minor: r.totals.amountMinor, tone: "text-success", hint: `${r.totals.count.toLocaleString()} payment${r.totals.count === 1 ? "" : "s"}` },
      { label: "Average payment", minor: r.totals.count ? Math.round(r.totals.amountMinor / r.totals.count) : 0 },
    ],
};

export default function RevenueReportPage() {
  return <AnalysisReportView config={CONFIG} />;
}
