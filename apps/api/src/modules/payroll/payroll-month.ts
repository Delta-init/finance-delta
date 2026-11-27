import { Types } from "mongoose";
import { PayrollRun } from "./payroll-run.model";

/*
 * Payroll counts in the month the pay is for (the user, 2026-11-27: "instead of re-date, just add a rule — it will show
 * only in that payroll month, in expenses and P&L"). A payroll payment's expense keeps the day it was paid; when a
 * report counts expenses for a period, it finds payroll expenses through their run's month instead of their date.
 */

/** The last day of a payroll month ("2026-10" → 31 October 2026, noon UTC so it is that day in Dubai too). */
export function payrollMonthEnd(period: string): Date {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y!, m!, 0, 12));
}

/** A payroll expense's run id, from its source key "payroll:<run id>:<payment id>". */
export const payrollRunIdOf = (key: unknown) => String(key ?? "").split(":")[1] ?? "";

/**
 * The payroll runs whose month counts in from..to (the month's last day is inside it), and:
 *   `clause` — finds their payroll expenses (match nothing when there are none);
 *   `month(key)` — any payroll expense's run month ("2026-10"), for placing and labelling it.
 * With no from/to, every run counts.
 */
export async function payrollInPeriod(orgId: string, from?: string, to?: string) {
  const runs = await PayrollRun.find({ organizationId: new Types.ObjectId(orgId) }).select("period").lean<{ _id: Types.ObjectId; period: string }[]>();
  const lo = from ? Date.parse(`${from}T00:00:00.000Z`) : -Infinity;
  const hi = to ? Date.parse(`${to}T23:59:59.999Z`) : Infinity;
  const periodOf = new Map(runs.map((r) => [String(r._id), r.period]));
  const counted = runs.filter((r) => { const t = payrollMonthEnd(r.period).getTime(); return t >= lo && t <= hi; });
  const clause = counted.length
    ? { "source.kind": "payroll", "source.key": { $regex: counted.map((r) => `^payroll:${r._id}:`).join("|") } }
    : { _id: { $exists: false } };
  return { clause, month: (key: unknown) => periodOf.get(payrollRunIdOf(key)) ?? "" };
}
