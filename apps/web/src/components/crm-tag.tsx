import { ENROLMENT_CRM_LABELS, type EnrolmentCrm } from "@delta/shared";
import { cn } from "@/lib/utils";

const CRM_STYLES: Record<EnrolmentCrm, string> = {
  delta: "bg-sky-500/10 text-sky-700",
  remote: "bg-amber-500/10 text-amber-700",
  draw: "bg-violet-500/10 text-violet-700",
  banglore: "bg-emerald-500/10 text-emerald-700",
};

/**
 * Which sales CRM sold an enrolment — Sales CRM, Remote CRM, Draw or the Banglore CRM — as the
 * same small tag the LMS and Tetra Commission show. Nothing for an enrolment
 * typed in finance: no CRM sold it.
 */
export function CrmTag({ crm, className }: { crm?: EnrolmentCrm | null; className?: string }) {
  if (!crm) return null;
  const label = ENROLMENT_CRM_LABELS[crm];
  return (
    <span
      className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium", CRM_STYLES[crm], className)}
      title={`Sold through the ${label}`}
    >
      {label}
    </span>
  );
}
