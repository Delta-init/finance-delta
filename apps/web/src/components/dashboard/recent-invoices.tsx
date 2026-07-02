"use client";

import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardStats } from "@/features/dashboard/api";

type Tone = "success" | "danger" | "primary" | "neutral" | "warning";

function statusTone(status: string): Tone {
  switch (status.toLowerCase()) {
    case "paid": return "success";
    case "overdue": return "danger";
    case "sent":
    case "viewed": return "primary";
    case "partial": return "warning";
    default: return "neutral";
  }
}

function fmtDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export function RecentInvoices() {
  const { data, isLoading } = useDashboardStats();

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Recent Invoices</CardTitle>
            <CardDescription>Latest activity across your workspace</CardDescription>
          </div>
          <Link
            href="/invoices"
            className="text-xs font-medium text-primary hover:underline"
          >
            View all
          </Link>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-foreground-subtle">
              <th className="px-5 py-3 font-medium">Invoice</th>
              <th className="px-5 py-3 font-medium">Customer</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Due</th>
              <th className="px-5 py-3 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i} className="border-b border-border last:border-0">
                    <td className="px-5 py-3"><Skeleton className="h-4 w-20" /></td>
                    <td className="px-5 py-3"><Skeleton className="h-4 w-32" /></td>
                    <td className="px-5 py-3"><Skeleton className="h-5 w-14 rounded-full" /></td>
                    <td className="px-5 py-3"><Skeleton className="h-4 w-14" /></td>
                    <td className="px-5 py-3 flex justify-end"><Skeleton className="h-4 w-20" /></td>
                  </tr>
                ))
              : data?.recentInvoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-border last:border-0 hover:bg-surface-muted/50 transition-colors">
                    <td className="px-5 py-3 font-medium">
                      <Link href={`/invoices/${inv.id}`} className="hover:text-primary hover:underline">
                        {inv.number}
                      </Link>
                    </td>
                    <td className="px-5 py-3 text-foreground-muted">{inv.customerName}</td>
                    <td className="px-5 py-3">
                      <Badge tone={statusTone(inv.status)} className="capitalize">
                        {inv.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-foreground-muted">{fmtDate(inv.dueDate)}</td>
                    <td className="px-5 py-3 text-right font-numeric font-medium">
                      {(inv.totalMinor / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
