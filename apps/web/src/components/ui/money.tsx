import { formatMoney } from "@delta/shared";
import { cn } from "@/lib/utils";

/** Renders integer minor units as formatted currency with tabular figures. */
export function MoneyDisplay({
  minor,
  currency = "AED",
  className,
}: {
  minor: number;
  currency?: string;
  className?: string;
}) {
  return (
    <span className={cn("font-numeric", className)}>
      {formatMoney(minor, currency)}
    </span>
  );
}
