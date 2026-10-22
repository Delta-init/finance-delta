/**
 * A list's "to" date as the whole of that day (2026-10-22): "2026-10-22" matches anything before 2026-10-23. Until
 * then it was compared as the day's first instant, so a record with a time later that day — one an approval or HRMS
 * made — fell outside its own day, and "Today" found almost nothing. A full timestamp is taken as it is.
 */
export function throughDay(v: string): Record<string, Date> {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? { $lt: new Date(Date.parse(`${v}T00:00:00.000Z`) + 86_400_000) } : { $lte: new Date(v) };
}
