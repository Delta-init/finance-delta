"use client";

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardStats } from "@/features/dashboard/api";
import { useCurrency } from "@/lib/currency-context";

export function TopCustomers() {
  const { data, isLoading } = useDashboardStats();
  const { currency, convert } = useCurrency();

  const customers = data?.topCustomers ?? [];
  const maxRevenue = customers.length > 0 ? Math.max(...customers.map((c) => c.revenueMinor)) : 1;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top Customers</CardTitle>
        <CardDescription>By revenue — last 6 months</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading
          ? Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3.5 w-16" />
                </div>
                <Skeleton className="h-1.5 w-full rounded-full" />
              </div>
            ))
          : customers.length === 0
          ? (
            <p className="text-sm text-foreground-muted text-center py-4">No customer data yet</p>
          )
          : customers.map((customer) => {
              const pct = maxRevenue > 0 ? (customer.revenueMinor / maxRevenue) * 100 : 0;
              const amount = (convert(customer.revenueMinor) / 100).toLocaleString("en-US", {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              });
              return (
                <div key={customer.name} className="space-y-1.5">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium truncate max-w-[60%]">{customer.name}</span>
                    <span className="font-numeric text-foreground-muted text-xs">
                      {currency} {amount}
                    </span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-surface-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
      </CardContent>
    </Card>
  );
}
