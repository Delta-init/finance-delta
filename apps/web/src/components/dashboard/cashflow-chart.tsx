"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardDescription, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useDashboardStats } from "@/features/dashboard/api";

const fmt = (v: number) => `${(v / 100000).toFixed(0)}k`;

export function CashflowChart() {
  const { data, isLoading } = useDashboardStats();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cash Flow</CardTitle>
        <CardDescription>Money in vs. money out by month</CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[300px] w-full" />
        ) : !data || data.cashflow.length === 0 ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-foreground-muted">
            No cashflow data yet
          </div>
        ) : (
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={data.cashflow}
                margin={{ left: -12, right: 8, top: 4 }}
              >
                <defs>
                  <linearGradient id="cf-inflow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="cf-outflow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--danger)" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="var(--danger)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  vertical={false}
                />
                <XAxis
                  dataKey="month"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "var(--foreground-subtle)", fontSize: 12 }}
                />
                <YAxis
                  tickFormatter={fmt}
                  tickLine={false}
                  axisLine={false}
                  tick={{ fill: "var(--foreground-subtle)", fontSize: 12 }}
                  width={48}
                />
                <Tooltip
                  contentStyle={{
                    borderRadius: 10,
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    fontSize: 12,
                    boxShadow: "var(--shadow-md)",
                  }}
                  formatter={(v: number, name: string) => [
                    `${data.currency} ${(v / 100).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`,
                    name === "inflowMinor" ? "Money In" : "Money Out",
                  ]}
                />
                <Legend
                  formatter={(value) => (value === "inflowMinor" ? "Money In" : "Money Out")}
                  wrapperStyle={{ fontSize: 12 }}
                />
                <Area
                  type="monotone"
                  dataKey="inflowMinor"
                  stroke="var(--primary)"
                  strokeWidth={2}
                  fill="url(#cf-inflow)"
                />
                <Area
                  type="monotone"
                  dataKey="outflowMinor"
                  stroke="var(--danger)"
                  strokeWidth={2}
                  fill="url(#cf-outflow)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
