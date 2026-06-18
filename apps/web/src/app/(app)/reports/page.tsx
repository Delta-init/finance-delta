"use client";

import { useRouter } from "next/navigation";
import {
  BarChart3,
  ArrowDownCircle,
  ArrowUpCircle,
  TrendingUp,
  Scale,
  Activity,
  Receipt,
  FileBarChart,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

interface ReportCategory {
  href: string;
  icon: LucideIcon;
  iconBg: string;
  iconColor: string;
  title: string;
  description: string;
  reports: string[];
}

const CATEGORIES: ReportCategory[] = [
  {
    href: "/reports/receivables",
    icon: ArrowDownCircle,
    iconBg: "bg-success/10",
    iconColor: "text-success",
    title: "Receivables",
    description: "Track outstanding invoices and incoming payments.",
    reports: [
      "Total payments received",
      "Aged receivables (0–30, 31–60, 61–90, 90+ days)",
      "Invoice summary by salesperson / customer / tag",
    ],
  },
  {
    href: "/reports/payables",
    icon: ArrowUpCircle,
    iconBg: "bg-danger/10",
    iconColor: "text-danger",
    title: "Payables",
    description: "Monitor bills due and vendor payment history.",
    reports: [
      "Total payments made",
      "Aged payables by due date bands",
    ],
  },
  {
    href: "/reports/profit-loss",
    icon: TrendingUp,
    iconBg: "bg-primary/10",
    iconColor: "text-primary",
    title: "Profit & Loss",
    description: "Income, expenses, and net profit over any period.",
    reports: [
      "Monthly and annual P&L",
      "Comparative P&L (current vs. prior period)",
      "Breakdown by expense category",
    ],
  },
  {
    href: "/reports/balance-sheet",
    icon: Scale,
    iconBg: "bg-warning/10",
    iconColor: "text-warning",
    title: "Balance Sheet",
    description: "Assets, liabilities, and equity at a point in time.",
    reports: [
      "Assets, liabilities & equity snapshot",
      "Comparative balance sheet between two periods",
    ],
  },
  {
    href: "/reports/cash-flow",
    icon: Activity,
    iconBg: "bg-primary/10",
    iconColor: "text-primary",
    title: "Cash Flow",
    description: "Where cash comes from and where it goes.",
    reports: [
      "Operating cash flow",
      "Investing cash flow",
      "Financing cash flow",
    ],
  },
  {
    href: "/reports/tax",
    icon: Receipt,
    iconBg: "bg-neutral/10",
    iconColor: "text-foreground-muted",
    title: "Tax Reports",
    description: "VAT, TDS, and GST compliance reports.",
    reports: [
      "UAE VAT return (output / input / net)",
      "TDS / GST reports (India)",
      "Tax summary by rate and period",
    ],
  },
  {
    href: "/reports/other",
    icon: FileBarChart,
    iconBg: "bg-success/10",
    iconColor: "text-success",
    title: "Other Reports",
    description: "Sales, commissions, reconciliation, and ledger reports.",
    reports: [
      "Sales by item · Expense by category",
      "Commission by salesperson · Customer statement",
      "Bank reconciliation · Trial balance · General ledger",
    ],
  },
];

export default function ReportsPage() {
  const router = useRouter();

  return (
    <div className="space-y-6 p-6">
      <PageHeader
        icon={BarChart3}
        title="Reports"
        description="Financial insights across receivables, payables, P&L, balance sheet, cash flow, tax, and more."
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.href}
            onClick={() => router.push(cat.href)}
            className="group flex flex-col gap-4 rounded-xl border border-border bg-surface p-5 text-left transition-all hover:border-primary/40 hover:shadow-md hover:shadow-primary/5"
          >
            {/* Header */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${cat.iconBg}`}>
                  <cat.icon className={`h-5 w-5 ${cat.iconColor}`} />
                </span>
                <div>
                  <h3 className="font-semibold text-foreground">{cat.title}</h3>
                  <p className="mt-0.5 text-xs text-foreground-muted">{cat.description}</p>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-foreground-subtle transition-transform group-hover:translate-x-0.5" />
            </div>

            {/* Report list */}
            <ul className="space-y-1.5 border-t border-border pt-3">
              {cat.reports.map((r) => (
                <li key={r} className="flex items-start gap-2 text-sm text-foreground-muted">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-border" />
                  {r}
                </li>
              ))}
            </ul>

            {/* Footer */}
            <div className="mt-auto">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={(e) => { e.stopPropagation(); router.push(cat.href); }}
              >
                View reports
              </Button>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
