/*
 * The date ranges a list offers as buttons (2026-10-22) — what each one means, as dates. Days are Dubai days, weeks
 * start on Monday. No React here, so it can be checked on its own.
 */

export const DATE_RANGES = ["all", "today", "week", "month", "30d", "custom"] as const;
export type DateRangeKey = (typeof DATE_RANGES)[number];
export const DATE_RANGE_LABELS: Record<DateRangeKey, string> = { all: "All time", today: "Today", week: "This week", month: "This month", "30d": "Last 30 days", custom: "Custom" };

const DUBAI_MS = 4 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** The two dates a range stands for, today being Dubai's. */
export function rangeDates(key: Exclude<DateRangeKey, "all" | "custom">, now: Date = new Date()): { from: string; to: string } {
  const today = new Date(now.getTime() + DUBAI_MS);
  today.setUTCHours(0, 0, 0, 0);
  const add = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
  if (key === "today") return { from: iso(today), to: iso(today) };
  if (key === "30d") return { from: iso(add(today, -29)), to: iso(today) };
  if (key === "week") {
    const monday = add(today, -((today.getUTCDay() + 6) % 7));
    return { from: iso(monday), to: iso(add(monday, 6)) };
  }
  const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return { from: iso(first), to: iso(last) };
}

