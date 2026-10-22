import type { DailyReportRow } from "@delta/shared";

/*
 * The Daily Report by day, by week or by month (the user, 2026-10-22: "the daily report page can switch to weekly and
 * monthly also"). Weeks run Monday to Sunday, months are calendar months. The days the report already has are only
 * added up, so a week's or a month's figures always equal its days'. A period cut short by the report's From or To
 * says so, and keeps the dates it actually covers — what its breakdown and its drill-down use.
 */

export const DAILY_VIEWS = ["day", "week", "month"] as const;
export type DailyView = (typeof DAILY_VIEWS)[number];

export interface PeriodRow {
  key: string;
  label: string;
  /** "(from 5 Oct)", "(to 22 Oct)" — when the report's dates cut it short; "" otherwise. */
  note: string;
  /** The dates it covers within the report. */
  from: string;
  to: string;
  incomeMinor: number;
  expenseMinor: number;
  revenueMinor: number;
  netMinor: number;
}

const DAY_MS = 86_400_000;
const at = (d: string) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const fmt = (d: string, opts: Intl.DateTimeFormatOptions) => new Date(at(d)).toLocaleDateString("en-GB", { timeZone: "UTC", ...opts });
const dayMonth = (d: string) => fmt(d, { day: "numeric", month: "short" });

function periodOf(date: string, view: Exclude<DailyView, "day">): { key: string; start: string; end: string; label: string } {
  if (view === "month") {
    const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
    const start = iso(Date.UTC(y, m - 1, 1)), end = iso(Date.UTC(y, m, 0));
    return { key: start.slice(0, 7), start, end, label: fmt(start, { month: "long", year: "numeric" }) };
  }
  const ms = at(date);
  const monday = ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;
  const start = iso(monday), end = iso(monday + 6 * DAY_MS);
  const label = start.slice(0, 4) !== end.slice(0, 4)
    ? `${fmt(start, { day: "numeric", month: "short", year: "numeric" })} – ${fmt(end, { day: "numeric", month: "short", year: "numeric" })}`
    : start.slice(5, 7) !== end.slice(5, 7)
      ? `${dayMonth(start)} – ${fmt(end, { day: "numeric", month: "short", year: "numeric" })}`
      : `${fmt(start, { day: "numeric" })}–${fmt(end, { day: "numeric", month: "short", year: "numeric" })}`;
  return { key: start, start, end, label };
}

/** The report's rows as days, weeks or months — newest first, as the days come. */
export function groupDaily(rows: DailyReportRow[], view: DailyView, rangeFrom: string, rangeTo: string): PeriodRow[] {
  if (view === "day") {
    return rows.map((r) => ({
      key: r.date, label: r.date, note: "", from: r.date, to: r.date,
      incomeMinor: r.incomeMinor, expenseMinor: r.expenseMinor, revenueMinor: r.revenueMinor, netMinor: r.netMinor,
    }));
  }
  const by = new Map<string, PeriodRow>();
  for (const r of rows) {
    const p = periodOf(r.date, view);
    let g = by.get(p.key);
    if (!g) {
      const from = rangeFrom && rangeFrom > p.start ? rangeFrom : p.start;
      const to = rangeTo && rangeTo < p.end ? rangeTo : p.end;
      const cut = [from > p.start ? `from ${dayMonth(from)}` : "", to < p.end ? `to ${dayMonth(to)}` : ""].filter(Boolean).join(", ");
      g = { key: p.key, label: p.label, note: cut ? `(${cut})` : "", from, to, incomeMinor: 0, expenseMinor: 0, revenueMinor: 0, netMinor: 0 };
      by.set(p.key, g);
    }
    g.incomeMinor += r.incomeMinor;
    g.expenseMinor += r.expenseMinor;
    g.revenueMinor += r.revenueMinor;
    g.netMinor += r.netMinor;
  }
  return [...by.values()].sort((a, b) => b.key.localeCompare(a.key));
}
