"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardDescription, CardTitle } from "@/components/ui/card";

const DATA = [
  { month: "Jan", inflow: 92000, outflow: 61000 },
  { month: "Feb", inflow: 105000, outflow: 68000 },
  { month: "Mar", inflow: 98000, outflow: 72000 },
  { month: "Apr", inflow: 121000, outflow: 70000 },
  { month: "May", inflow: 134000, outflow: 81000 },
  { month: "Jun", inflow: 142000, outflow: 78000 },
  { month: "Jul", inflow: 156000, outflow: 86000 },
  { month: "Aug", inflow: 149000, outflow: 90000 },
];

const fmt = (v: number) => `${(v / 1000).toFixed(0)}k`;

export function CashflowChart() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cash Flow</CardTitle>
        <CardDescription>Inflow vs. outflow — last 8 months (AED)</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={DATA} margin={{ left: -12, right: 8, top: 4 }}>
              <defs>
                <linearGradient id="inflow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--primary)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--primary)" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="outflow" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--success-600)" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="var(--success-600)" stopOpacity={0} />
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
                formatter={(v: number) => `AED ${v.toLocaleString()}`}
              />
              <Area
                type="monotone"
                dataKey="inflow"
                stroke="var(--primary)"
                strokeWidth={2}
                fill="url(#inflow)"
              />
              <Area
                type="monotone"
                dataKey="outflow"
                stroke="var(--success-600)"
                strokeWidth={2}
                fill="url(#outflow)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
