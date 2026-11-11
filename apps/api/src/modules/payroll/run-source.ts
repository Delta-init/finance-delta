import { AppError } from "../../lib/http";

/**
 * Whether a payroll run came from HRMS or was entered in finance (2026-11-11: manual payroll, for an organization not
 * run through HRMS). Every place that would call HRMS about a run asks this first: a manual run has no month in HRMS,
 * no payslips there and nobody there to tell, so nothing about it may ever reach HRMS.
 *
 * Kept free of models and config, like `recalculate.ts`, so the services that import it import nothing new.
 */

/** A run entered in finance. Runs from before this have no `source`: they came from HRMS. */
export function isManualRun(run: { source?: string | null }): boolean {
  return run.source === "manual";
}

/**
 * What a manual run keeps in `hrmsOrgId`: not an HRMS id (those are 24 hex characters), but its currency — so the
 * existing unique index on (organization, hrmsOrgId, period) holds one manual run per organization, month and currency.
 */
export function manualRunKey(currency: string): string {
  return `manual:${currency.trim().toUpperCase()}`;
}

/** The label a manual run shows where an HRMS run shows the HRMS organization it came from. */
export const MANUAL_RUN_FROM = "Entered in finance";

/** Refuses an HRMS-only action on a manual run, saying what to do instead. */
export function requireHrmsRun(run: { source?: string | null; runNumber: string }, action: string): void {
  if (!isManualRun(run)) return;
  throw new AppError(
    "CONFLICT",
    `${run.runNumber} was entered in finance, not imported from HRMS — ${action} is only for a month from HR. ` +
      `Change its people on the run itself before it is approved.`,
  );
}
