import { TrendingUp, TrendingDown } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Stat {
  label: string;
  value: string;
  delta: string;
  trend: "up" | "down";
  hint: string;
}

const STATS: Stat[] = [
  {
    label: "Total Revenue",
    value: "AED 1,250,000",
    delta: "+12.5%",
    trend: "up",
    hint: "Trending up this month",
  },
  {
    label: "Outstanding Receivables",
    value: "AED 342,800",
    delta: "-4.2%",
    trend: "down",
    hint: "Down from last period",
  },
  {
    label: "Outstanding Payables",
    value: "AED 128,400",
    delta: "+2.1%",
    trend: "up",
    hint: "Slightly higher this month",
  },
  {
    label: "Net Profit (MTD)",
    value: "AED 86,500",
    delta: "+8.0%",
    trend: "up",
    hint: "Strong margin this month",
  },
];

export function SectionCards() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {STATS.map((s) => {
        const Icon = s.trend === "up" ? TrendingUp : TrendingDown;
        return (
          <Card key={s.label} className="p-5">
            <p className="text-sm text-foreground-muted">{s.label}</p>
            <p className="mt-2 font-numeric text-2xl font-semibold tracking-tight">
              {s.value}
            </p>
            <div className="mt-3 flex items-center gap-2">
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                  s.trend === "up"
                    ? "bg-success/10 text-success"
                    : "bg-danger/10 text-danger",
                )}
              >
                <Icon className="h-3 w-3" />
                {s.delta}
              </span>
              <span className="text-xs text-foreground-subtle">{s.hint}</span>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
