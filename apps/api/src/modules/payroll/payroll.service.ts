import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { hrmsClient, type HrmsBatch } from "../../lib/hrms-client";
import { nextNumber } from "../sequence/sequence.service";
import { Employee } from "../employee/employee.model";
import { PayrollOrgLink } from "../payroll-mapping/org-link.model";
import { User } from "../user/user.model";
import { PayrollRun } from "./payroll-run.model";
import { toMinor, formatMinor, assertTotalsAgree } from "./money";

const oid = (id: string) => new Types.ObjectId(id);

/**
 * Importing a month of payroll from HRMS, and reading it back.
 *
 * The import is the moment two systems that have been describing the same
 * people separately have to agree about them. Most of what follows is that
 * agreement being checked rather than assumed: that the organization is linked,
 * that every person on the run is one finance already knows, that the figures
 * add up, and that nobody else has already imported the month.
 */

/** What a dry run reports, so nothing is written before somebody has seen it. */
export interface ImportPreview {
  period: string;
  hrmsOrgId: string;
  hrmsOrgName: string;
  currency: string;
  canImport: boolean;
  blockers: string[];
  warnings: string[];
  totals: { employeeCount: number; grossMinor: number; deductionsMinor: number; netMinor: number };
  unmapped: Array<{ hrmsEmployeeId: string; employeeCode: string; name: string }>;
  unpayable: Array<{ employeeCode: string; name: string }>;
  alreadyImported: { runNumber: string; status: string } | null;
}

async function requireLink(orgId: string, hrmsOrgId: string) {
  const link = await PayrollOrgLink.findOne({ organizationId: oid(orgId), hrmsOrgId, isActive: true }).lean();
  if (!link) {
    throw new AppError(
      "NOT_FOUND",
      "That HRMS organization is not linked to this book. Link it under Payroll mapping first.",
    );
  }
  return link;
}

/**
 * Resolves each HRMS payslip to a person finance already knows.
 *
 * An unmapped employee is a blocker rather than a row imported with a null
 * link. A payroll line that does not point at anybody is one nobody can chase
 * later — and it means the mapping is incomplete, which is a thing to go and
 * fix, not to work around.
 */
async function resolveEmployees(orgId: string, hrmsOrgId: string, batch: HrmsBatch) {
  const rows = await Employee.find({
    organizationId: oid(orgId),
    hrmsOrgId,
    hrmsEmployeeId: { $in: batch.lines.map((l) => l.employeeId) },
  }).lean();
  return new Map(rows.map((e) => [e.hrmsEmployeeId, e]));
}

/** The month's figures, converted and cross-checked, or an explanation. */
function convert(batch: HrmsBatch) {
  const currency = batch.currency;
  const lines = batch.lines.map((l) => {
    const grossMinor = toMinor(l.grossPay);
    const deductionsMinor = toMinor(l.totalDeductions);
    const netFromHrmsMinor = toMinor(l.netPay);
    return { source: l, grossMinor, deductionsMinor, netFromHrmsMinor };
  });

  const sum = lines.reduce(
    (a, l) => ({
      gross: a.gross + l.grossMinor,
      deductions: a.deductions + l.deductionsMinor,
      net: a.net + l.netFromHrmsMinor,
    }),
    { gross: 0, deductions: 0, net: 0 },
  );

  // Against HRMS's own recomputed totals, not its submit-time snapshot: the
  // snapshot may legitimately predate a correction, but the lines and the
  // totals computed from those same lines must agree exactly.
  assertTotalsAgree("Gross pay", sum.gross, toMinor(batch.totals.grossTotal), currency);
  assertTotalsAgree("Deductions", sum.deductions, toMinor(batch.totals.deductionTotal), currency);
  assertTotalsAgree("Net pay", sum.net, toMinor(batch.totals.netTotal), currency);

  return { lines, sum };
}

export async function previewImport(orgId: string, hrmsOrgId: string, period: string): Promise<ImportPreview> {
  const link = await requireLink(orgId, hrmsOrgId);
  const batch = await hrmsClient.payrollBatch(hrmsOrgId, period);

  const blockers: string[] = [];
  const warnings: string[] = [];

  if (batch.status !== "submitted" && batch.status !== "in_finance") {
    blockers.push(`HRMS reports this month as "${batch.status.replace("_", " ")}", not ready to import.`);
  }
  if (batch.lines.length === 0) {
    blockers.push("The month has no payslips.");
  }

  let totals = { employeeCount: 0, grossMinor: 0, deductionsMinor: 0, netMinor: 0 };
  try {
    const { sum } = convert(batch);
    totals = {
      employeeCount: batch.lines.length,
      grossMinor: sum.gross,
      deductionsMinor: sum.deductions,
      netMinor: sum.net,
    };
  } catch (e) {
    blockers.push((e as Error).message);
  }

  const known = await resolveEmployees(orgId, hrmsOrgId, batch);
  const unmapped = batch.lines
    .filter((l) => !known.has(l.employeeId))
    .map((l) => ({ hrmsEmployeeId: l.employeeId, employeeCode: l.employeeCode, name: l.name }));
  if (unmapped.length) {
    blockers.push(
      `${unmapped.length} person(s) on this payroll are not mapped in finance. Run a mapping sync first.`,
    );
  }

  const unpayable = batch.lines.filter((l) => !l.payable).map((l) => ({ employeeCode: l.employeeCode, name: l.name }));
  if (unpayable.length) {
    // A warning, not a blocker: the rest of the run can still be paid, and
    // holding fifty-nine people for one missing IBAN is the worse outcome.
    warnings.push(`${unpayable.length} person(s) have no bank details and will be held.`);
  }

  const existing = await PayrollRun.findOne({ organizationId: oid(orgId), hrmsOrgId, period }).lean();
  if (existing) {
    blockers.push(`This month has already been imported as ${existing.runNumber}.`);
  }

  if (batch.currency !== link.hrmsCurrency) {
    warnings.push(
      `HRMS is now running this payroll in ${batch.currency}, but the link was made for ${link.hrmsCurrency}.`,
    );
  }

  return {
    period,
    hrmsOrgId,
    hrmsOrgName: link.hrmsOrgName,
    currency: batch.currency,
    canImport: blockers.length === 0,
    blockers,
    warnings,
    totals,
    unmapped,
    unpayable,
    alreadyImported: existing ? { runNumber: existing.runNumber, status: existing.status } : null,
  };
}

/**
 * Import a month.
 *
 * Order matters: the run is written first, then HRMS is told who claimed it.
 * If the claim fails, finance holds a run that HRMS still thinks is merely
 * submitted — visible, fixable, and safe. Claiming first and then failing to
 * write would leave HRMS believing a payroll had been imported that does not
 * exist anywhere, which nothing would ever notice.
 */
export async function importRun(
  orgId: string,
  hrmsOrgId: string,
  period: string,
  actor: { userId: string },
) {
  const link = await requireLink(orgId, hrmsOrgId);
  const preview = await previewImport(orgId, hrmsOrgId, period);
  if (!preview.canImport) {
    throw new AppError("CONFLICT", preview.blockers.join(" "));
  }

  const batch = await hrmsClient.payrollBatch(hrmsOrgId, period);
  const { lines, sum } = convert(batch);
  const known = await resolveEmployees(orgId, hrmsOrgId, batch);

  const runNumber = await nextNumber(orgId, "payroll_run", `PAY-${period.replace("-", "")}-`, 3);
  const user = await User.findById(oid(actor.userId)).select("name").lean();

  const docLines = lines.map(({ source, grossMinor, deductionsMinor, netFromHrmsMinor }) => {
    const employee = known.get(source.employeeId)!;
    return {
      hrmsPayslipId: source.payslipId,
      hrmsEmployeeId: source.employeeId,
      employeeId: employee._id,
      employeeCode: source.employeeCode,
      name: source.name,
      designation: source.designation,
      // The finance department, resolved through the mapping — not the HRMS
      // department id, which means nothing on this side.
      departmentId: employee.departmentId ?? null,
      departmentName: source.departmentName,
      earnings: source.earnings.map((e) => ({ label: e.label, amountMinor: toMinor(e.amount) })),
      deductions: source.deductions.map((d) => ({ label: d.label, amountMinor: toMinor(d.amount) })),
      grossMinor,
      deductionsMinor,
      netFromHrmsMinor,
      adjustmentsMinor: 0,
      payableMinor: netFromHrmsMinor,
      amountPaidMinor: 0,
      bank: source.bank,
      payable: source.payable,
      // Someone with nowhere to send money starts held, so they cannot be swept
      // into a bulk payment and silently counted as paid.
      status: source.payable ? ("pending" as const) : ("on_hold" as const),
      holdReason: source.payable ? "" : "No bank details in HRMS",
    };
  });

  const run = await PayrollRun.create({
    organizationId: oid(orgId),
    hrmsOrgId,
    hrmsOrgName: link.hrmsOrgName,
    runNumber,
    period,
    currency: batch.currency,
    status: "imported",
    lines: docLines,
    hrmsGrossMinor: sum.gross,
    hrmsDeductionsMinor: sum.deductions,
    hrmsNetMinor: sum.net,
    adjustmentsMinor: 0,
    payableMinor: sum.net,
    amountPaidMinor: 0,
    balanceMinor: sum.net,
    importedById: oid(actor.userId),
    importedByName: user?.name ?? "",
    importedAt: new Date(),
  });

  let claimWarning: string | null = null;
  try {
    await hrmsClient.claimPayrollBatch(hrmsOrgId, period, runNumber);
  } catch (e) {
    // Reported, not thrown. The run is real and correct; HRMS simply has not
    // been told yet, and re-claiming is safe because the claim is idempotent.
    claimWarning =
      `The payroll was imported as ${runNumber}, but HRMS could not be told: ${(e as Error).message} ` +
      `HR will still see the month as submitted until this is retried.`;
  }

  return {
    id: String(run._id),
    runNumber,
    period,
    currency: batch.currency,
    employeeCount: docLines.length,
    netMinor: sum.net,
    netFormatted: formatMinor(sum.net, batch.currency),
    warnings: [...preview.warnings, ...(claimWarning ? [claimWarning] : [])],
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export async function listRuns(
  orgId: string,
  query: { period?: string; status?: string; page?: number; limit?: number },
) {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 20));
  const filter: Record<string, unknown> = { organizationId: oid(orgId) };
  if (query.period) filter.period = query.period;
  if (query.status) filter.status = query.status;

  const [rows, total] = await Promise.all([
    PayrollRun.find(filter)
      .select("-lines")
      .sort({ period: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    PayrollRun.countDocuments(filter),
  ]);

  return {
    data: rows.map((r) => ({
      id: String(r._id),
      runNumber: r.runNumber,
      period: r.period,
      hrmsOrgName: r.hrmsOrgName,
      currency: r.currency,
      status: r.status,
      payableMinor: r.payableMinor,
      amountPaidMinor: r.amountPaidMinor,
      balanceMinor: r.balanceMinor,
      importedAt: r.importedAt ? (r.importedAt as Date).toISOString() : null,
      importedByName: r.importedByName,
    })),
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

export async function getRun(orgId: string, id: string) {
  const run = await PayrollRun.findOne({ _id: oid(id), organizationId: oid(orgId) }).lean();
  if (!run) throw new AppError("NOT_FOUND", "Payroll run not found");

  return {
    id: String(run._id),
    runNumber: run.runNumber,
    period: run.period,
    hrmsOrgId: run.hrmsOrgId,
    hrmsOrgName: run.hrmsOrgName,
    currency: run.currency,
    status: run.status,
    totals: {
      employeeCount: run.lines.length,
      hrmsGrossMinor: run.hrmsGrossMinor,
      hrmsDeductionsMinor: run.hrmsDeductionsMinor,
      hrmsNetMinor: run.hrmsNetMinor,
      adjustmentsMinor: run.adjustmentsMinor,
      payableMinor: run.payableMinor,
      amountPaidMinor: run.amountPaidMinor,
      balanceMinor: run.balanceMinor,
      heldCount: run.lines.filter((l) => l.status === "on_hold").length,
    },
    lines: run.lines.map((l) => ({
      id: String(l._id),
      hrmsEmployeeId: l.hrmsEmployeeId,
      employeeId: l.employeeId ? String(l.employeeId) : null,
      employeeCode: l.employeeCode,
      name: l.name,
      designation: l.designation,
      departmentName: l.departmentName,
      earnings: l.earnings,
      deductions: l.deductions,
      grossMinor: l.grossMinor,
      deductionsMinor: l.deductionsMinor,
      netFromHrmsMinor: l.netFromHrmsMinor,
      adjustmentsMinor: l.adjustmentsMinor,
      payableMinor: l.payableMinor,
      amountPaidMinor: l.amountPaidMinor,
      status: l.status,
      holdReason: l.holdReason,
      payable: l.payable,
      bank: l.bank,
    })),
    importedAt: run.importedAt ? (run.importedAt as Date).toISOString() : null,
    importedByName: run.importedByName,
    notes: run.notes,
  };
}

/** Months HRMS is offering that this book has not taken yet. */
export async function listAvailable(orgId: string) {
  const links = await PayrollOrgLink.find({ organizationId: oid(orgId), isActive: true }).lean();
  const out: Array<{
    hrmsOrgId: string; hrmsOrgName: string; period: string; status: string;
    currency: string; employeeCount: number; netTotal: number; imported: boolean; runNumber: string | null;
  }> = [];

  for (const link of links) {
    const batches = await hrmsClient.payrollBatches(link.hrmsOrgId).catch(() => []);
    const runs = await PayrollRun.find({ organizationId: oid(orgId), hrmsOrgId: link.hrmsOrgId })
      .select("period runNumber")
      .lean();
    const runByPeriod = new Map(runs.map((r) => [r.period, r.runNumber]));

    for (const b of batches) {
      out.push({
        hrmsOrgId: link.hrmsOrgId,
        hrmsOrgName: link.hrmsOrgName,
        period: b.month,
        status: b.status,
        currency: b.currency,
        employeeCount: b.employeeCount,
        netTotal: b.netTotal,
        imported: runByPeriod.has(b.month),
        runNumber: runByPeriod.get(b.month) ?? null,
      });
    }
  }
  return out.sort((a, b) => b.period.localeCompare(a.period));
}
