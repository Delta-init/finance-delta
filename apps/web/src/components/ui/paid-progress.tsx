import { cn } from "@/lib/utils";

/**
 * How much of a total is paid (2026-11-12: "progress also … how much paid"): a thin bar and the percentage. Never
 * 100% while something is still owed and never 0% once something is paid — a rounded figure must not say otherwise.
 * Nothing at all for a total of zero.
 */
export function paidPercent(paidMinor: number, totalMinor: number): number {
  if (!(totalMinor > 0)) return 0;
  if (paidMinor >= totalMinor) return 100;
  if (!(paidMinor > 0)) return 0;
  return Math.min(99, Math.max(1, Math.round((paidMinor / totalMinor) * 100)));
}

export function PaidProgress({ paidMinor, totalMinor, className }: { paidMinor: number; totalMinor: number; className?: string }) {
  if (!(totalMinor > 0)) return null;
  const pct = paidPercent(paidMinor, totalMinor);
  return (
    <div className={cn("flex items-center gap-1.5", className)} title={`${pct}% paid`}>
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={cn("h-full rounded-full", pct >= 100 ? "bg-success" : "bg-warning")} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right text-[11px] tabular-nums text-foreground-muted">{pct}%</span>
    </div>
  );
}
