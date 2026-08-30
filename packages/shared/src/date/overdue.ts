/**
 * How late an invoice is, in whole days.
 *
 * Compared date to date rather than instant to instant. An invoice due today is
 * not "late by a few hours" at 6pm, and one due yesterday is a full day late at
 * 9am — a counsellor ringing a student cares which calendar day it was due, not
 * how many hours have elapsed.
 *
 * Both sides are reduced to a calendar day before subtracting, so the answer
 * does not change with the time of day or shift by one either side of a
 * daylight-saving boundary.
 */
export function daysOverdue(dueDate: string, today: Date = new Date()): number {
  const [y, m, d] = dueDate.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return 0;
  const due = Date.UTC(y, m - 1, d);
  const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((now - due) / 86400000);
}

/** The same, said the way it appears under a student's name. */
export function describeOverdue(dueDate: string, today: Date = new Date()): string {
  const days = daysOverdue(dueDate, today);
  if (days < 0) return days === -1 ? "due tomorrow" : `due in ${-days} days`;
  if (days === 0) return "due today";
  return days === 1 ? "1 day late" : `${days} days late`;
}
