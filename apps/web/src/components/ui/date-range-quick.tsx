"use client";

import { useSearchParams } from "next/navigation";
import { DatePicker } from "@/components/ui/date-picker";
import { writeQuery } from "@/lib/url-state";
import { cn } from "@/lib/utils";
import { DATE_RANGES, DATE_RANGE_LABELS as LABELS, rangeDates, type DateRangeKey } from "@/lib/date-range";

export { DATE_RANGES, rangeDates, type DateRangeKey };

/*
 * A list's date range as buttons (the user, 2026-10-22: "date range filter with buttons — daily, weekly, this month,
 * last 30 days and custom; click custom and edit the range"). Days are Dubai days, weeks start on Monday. Kept in the
 * address bar as the choice itself (?range=month), so a saved link still means "this month" next month; Custom keeps
 * its two dates. A link that brings only dates (an older one) reads as Custom.
 */

/** The range in the address bar: which one, the dates it means, and its setters (each back to page 1). */
export function useUrlDateRange(opts: { fromKey: string; toKey: string; rangeKey?: string; page?: string }) {
  const { fromKey, toKey } = opts;
  const rangeKey = opts.rangeKey ?? "range";
  const page = opts.page ?? "page";
  const search = useSearchParams();
  const raw = search.get(rangeKey);
  const typedFrom = search.get(fromKey) ?? "";
  const typedTo = search.get(toKey) ?? "";
  const range: DateRangeKey = (DATE_RANGES as readonly string[]).includes(raw ?? "")
    ? (raw as DateRangeKey)
    : typedFrom || typedTo ? "custom" : "all";
  const dates = range === "all" ? { from: "", to: "" } : range === "custom" ? { from: typedFrom, to: typedTo } : rangeDates(range);

  const setRange = (next: DateRangeKey) => {
    if (next === "custom") {
      // Starts from what was showing, to be edited.
      writeQuery({ [rangeKey]: "custom", [fromKey]: dates.from || null, [toKey]: dates.to || null, [page]: null });
    } else {
      writeQuery({ [rangeKey]: next === "all" ? null : next, [fromKey]: null, [toKey]: null, [page]: null });
    }
  };
  const setFrom = (v: string) => writeQuery({ [rangeKey]: "custom", [fromKey]: v || null, [page]: null });
  const setTo = (v: string) => writeQuery({ [rangeKey]: "custom", [fromKey]: dates.from || null, [toKey]: v || null, [page]: null });
  return { range, from: dates.from, to: dates.to, setRange, setFrom, setTo };
}

const short = (d: string) => (d ? new Date(`${d}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", day: "numeric", month: "short" }) : "");

/** The buttons, and — for Custom — the two dates to edit; a preset says which dates it stands for. */
export function DateRangeQuick({ value }: { value: ReturnType<typeof useUrlDateRange> }) {
  const { range, from, to, setRange, setFrom, setTo } = value;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-0.5" role="tablist" aria-label="Date range">
        {DATE_RANGES.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={range === key}
            onClick={() => setRange(key)}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors sm:text-sm",
              range === key ? "bg-primary text-primary-foreground shadow-sm" : "text-foreground-muted hover:text-foreground",
            )}
          >
            {LABELS[key]}
          </button>
        ))}
      </div>
      {range === "custom" ? (
        <div className="flex items-center gap-1.5">
          <DatePicker value={from} onChange={setFrom} clearable placeholder="From" className="w-[140px]" />
          <span className="text-foreground-subtle">→</span>
          <DatePicker value={to} onChange={setTo} clearable placeholder="To" className="w-[140px]" />
        </div>
      ) : range !== "all" && (
        <span className="whitespace-nowrap text-xs text-foreground-muted">{from === to ? short(from) : `${short(from)} – ${short(to)}`}</span>
      )}
    </div>
  );
}
