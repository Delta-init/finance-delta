/** The attendance deductions HRMS prices off the salary, a day at a time. */
export const ATTENDANCE_PREFIXES = ["Loss of Pay", "Late Penalty", "Early-Out Penalty"];

export const isAttendance = (label: string) => ATTENDANCE_PREFIXES.some((p) => label.startsWith(p));

/**
 * What putting somebody on their CRM salary slab changes on a payslip (2026-11-01), in minor units:
 *
 *   slab on this payslip   = slab × (salary paid ÷ contract salary)        a part month keeps its share
 *   attendance on the slab = each attendance deduction × slab ÷ contract salary, never more than the slab paid
 *   difference             = (slab on this payslip − salary paid) − (attendance on the slab − attendance HR sent)
 *
 * Positive is an addition, negative a deduction. `monthly` must be above zero.
 */
export function slabDifference(input: { monthly: number; paid: number; slab: number; attendance: number[] }) {
  const { monthly, paid, slab, attendance } = input;
  const onSlip = Math.round(slab * Math.min(1, paid / monthly));
  const hrAttendance = attendance.reduce((t, a) => t + a, 0);
  const slabAttendance = Math.min(onSlip, attendance.reduce((t, a) => t + Math.round((a * slab) / monthly), 0));
  return { onSlip, hrAttendance, slabAttendance, difference: onSlip - paid - (slabAttendance - hrAttendance) };
}
