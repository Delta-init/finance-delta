"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardStats } from "@/features/dashboard/api";
import { useCurrency } from "@/lib/currency-context";
import { useOpenBreakdown } from "@/features/dashboard/DashboardBreakdown";

export function ExpenseChart() {
  const { data, isLoading } = useDashboardStats();
  const { currency, convert } = useCurrency();

  const breakdown = data?.expenseBreakdown ?? [];
  const chartData = breakdown.map((e) => ({
    category: e.category,
    categoryKey: e.categoryKey,
    amount: e.totalMinor,
  }));
  const open = useOpenBreakdown();
  // A category's expenses over the chart's three months (2026-10-26) — needs the API's categoryKey.
  const openCategory = (row?: { category: string; categoryKey?: string }) => {
    if (row?.categoryKey) open({ label: `${row.category} — last 3 months`, parts: [{ kind: "category", category: row.categoryKey }] });
  };

  const fmtAmount = (v: number) =>
    `${(convert(v) / 100000).toFixed(0)}k`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Expenses by Category</CardTitle>
        <CardDescription>Last 3 months — click a category to see its expenses</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[200px] w-full" />
        ) : chartData.length === 0 ? (
          <div className="flex h-[200px] items-center justify-center text-sm text-foreground-muted">
            No expense data
          </div>
        ) : (
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={chartData}
                margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  horizontal={false}
                />
                <XAxis
                  type="number"
                  tickFormatter={fmtAmount}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "var(--foreground-subtle)", fontSize: 11 }}
                />
                <YAxis
                  type="category"
                  dataKey="category"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "var(--foreground-subtle)", fontSize: 11 }}
                  width={90}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    fontSize: 12,
                    boxShadow: "var(--shadow-md)",
                  }}
                  formatter={(v: number) => [
                    `${currency} ${(convert(v) / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
                    "Total",
                  ]}
                />
                <Bar
                  dataKey="amount"
                  fill="var(--primary)"
                  radius={[0, 4, 4, 0]}
                  className="cursor-pointer"
                  onClick={(d) => openCategory((d as { payload?: { category: string; categoryKey?: string } }).payload)}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
