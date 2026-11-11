import { Types } from "mongoose";
import {
  checkManualPayrollRows, manualPayrollLineSchema, MANUAL_GROSS_LABEL,
  type ManualLineCheck, type ManualPayrollLine, type ManualPayrollLineInput, type PayrollMode,
} from "@delta/shared";
import { AppError } from "../../lib/http";
import { nextNumber } from "../sequence/sequence.service";
import { Organization } from "../organization/organization.model";
import { Employee } from "../employee/employee.model";
import { Department } from "../department/department.model";
import { User } from "../user/user.model";
import { PayrollRun, type PayrollRunDoc } from "./payroll-run.model";
import { recalculate, type RecalcRun } from "./recalculate";
import { summariseByCurrency } from "./currency-totals";
import { isManualRun, manualRunKey, MANUAL_RUN_FROM } from "./run-source";

const oid = (id: string) => new Types.ObjectId(id);

/**
 * Manual payroll (the user, 2026-11-11: "In Payroll section there is no option to create or import data, still blank
 * page shows").
 *
 * The HQ book's payroll comes from HRMS, and stays that way. The Bangalore book is not run through HRMS, so its months
 * never arrived and its Payroll runs page stayed empty. An organization switched to manual (Settings → Payroll) creates
 * its months here instead — a month per currency — and puts its people on them, typed or imported from a sheet.
 *
 * A manual month is an ordinary PayrollRun (`source: "manual"`), so approving, paying, the bank line and the expense
 * each payment posts, reversing, and every report treat it exactly like a month from HR. What differs is only where the
 * people come from — here, until it is approved — and that nothing about it ever goes to HRMS: every call to HRMS
 * checks the run's source first (run-source.ts). Additions and deductions, commission and slab pulls, sending back to
 * HR: all of them are HRMS's, and refused on a manual month. Its people's pay is changed on their line instead.
 *
 * Each line keeps the existing shape: its gross as its one earning, its named deductions (PF, ESI, professional tax,
 * TDS, other) as its deductions, gross less deductions as its net and its payable. The rules for a line live in
 * @delta/shared, so the import preview in the browser and the API agree on every row.
 */

/** Where this organization's payroll comes from. Every organization is on HRMS until somebody switches it. */
export async function payrollModeOf(orgId: string): Promise<PayrollMode> {
  const org = await Organization.findById(oid(orgId)).select("payrollMode").lean<{ payrollMode?: string } | null>();
  return org?.payrollMode === "manual" ? "manual" : "hrms";
}

/** What the payroll pages need: where the months come from, and the currency a new month starts in. */
export async function payrollSetup(orgId: string): Promise<{ mode: PayrollMode; baseCurrency: string }> {
  const org = await Organization.findById(oid(orgId)).select("payrollMode baseCurrency").lean<{ payrollMode?: string; baseCurrency?: string } | null>();
  if (!org) throw new AppError("NOT_FOUND", "Organization not found");
  return { mode: org.payrollMode === "manual" ? "manual" : "hrms", baseCurrency: org.baseCurrency || "AED" };
}

/** One row the API refused, and why — said against its row in the file. */
export interface ManualRowProblem { rowNo: number; name: string; problems: string[] }

export interface CreateManualRunInput {
  period: string;
  /** The month's currency; the organization's own when left out. */
  currency?: string;
  notes?: string;
  /** People to put on it straight away (an import): the good ones are added, the rest reported. */
  lines?: ManualPayrollLineInput[];
}

const duplicateMonth = (period: string, currency: string, runNumber: string) =>
  new AppError("CONFLICT", `${period} in ${currency} is already ${runNumber} — open it to add or change people.`);

/** A new month, empty or with the good rows of an import. One per organization, month and currency. */
export async function createManualRun(orgId: string, input: CreateManualRunInput, actor: { userId: string }) {
  const org = await Organization.findById(oid(orgId)).select("payrollMode baseCurrency").lean<{ payrollMode?: string; baseCurrency?: string } | null>();
  if (!org) throw new AppError("NOT_FOUND", "Organization not found");
  if (org.payrollMode !== "manual") {
    throw new AppError(
      "CONFLICT",
      "This organization's payroll comes from HRMS — its months arrive from HR. To enter months here instead, switch it to manual in Settings → Payroll.",
    );
  }
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.period ?? "")) throw new AppError("VALIDATION_ERROR", "The month must be YYYY-MM");
  const currency = (input.currency?.trim() || org.baseCurrency || "AED").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new AppError("VALIDATION_ERROR", `"${input.currency}" is not a currency code`);

  const key = manualRunKey(currency);
  const existing = await PayrollRun.findOne({ organizationId: oid(orgId), hrmsOrgId: key, period: input.period }).select("runNumber").lean();
  if (existing) throw duplicateMonth(input.period, currency, existing.runNumber);

  // An import with nothing that can be created makes no month: the sheet is fixed and tried again.
  const lines = (input.lines ?? []).map((l) => manualPayrollLineSchema.parse(l));
  if (lines.length) {
    const checked = checkManualPayrollRows(lines, currency);
    if (!checked.good) {
      throw new AppError("VALIDATION_ERROR", `None of the ${lines.length} row(s) can be added — nothing was created.`, { problems: problemsOf(checked.rows) });
    }
  }

  const user = await User.findById(oid(actor.userId)).select("name").lean();
  const runNumber = await nextNumber(orgId, "payroll_run", `PAY-${input.period.replace("-", "")}-`, 3);
  let run;
  try {
    run = await PayrollRun.create({
      organizationId: oid(orgId),
      source: "manual",
      hrmsOrgId: key,
      hrmsOrgName: MANUAL_RUN_FROM,
      runNumber,
      period: input.period,
      currency,
      status: "imported",
      lines: [],
      importedById: oid(actor.userId),
      importedByName: user?.name ?? "",
      importedAt: new Date(),
      notes: (input.notes ?? "").trim().slice(0, 300),
    });
  } catch (e) {
    // Two people creating the same month at once: the unique index lets one through.
    if ((e as { code?: number }).code === 11000) {
      const other = await PayrollRun.findOne({ organizationId: oid(orgId), hrmsOrgId: key, period: input.period }).select("runNumber").lean();
      throw duplicateMonth(input.period, currency, other?.runNumber ?? "another run");
    }
    throw e;
  }

  let added = { created: 0, problems: [] as ManualRowProblem[] };
  if (lines.length) {
    added = await putLines(orgId, run, lines, { partial: true });
    await run.save();
  }
  return {
    id: String(run._id),
    runNumber,
    period: input.period,
    currency,
    created: added.created,
    problems: added.problems,
    byCurrency: summariseByCurrency(run.lines, currency),
  };
}

/** A manual run of this organization's, refusing one from HRMS — whose people HR changes, not finance. */
async function loadManualRun(orgId: string, runId: string) {
  if (!Types.ObjectId.isValid(runId)) throw new AppError("NOT_FOUND", "Payroll run not found");
  const run = await PayrollRun.findOne({ _id: oid(runId), organizationId: oid(orgId) });
  if (!run) throw new AppError("NOT_FOUND", "Payroll run not found");
  if (!isManualRun(run)) {
    throw new AppError("CONFLICT", `${run.runNumber} came from HRMS — who is on it, and their pay, change in HRMS, not here.`);
  }
  return run;
}

/** People can be added, changed or removed only before the month is approved. */
function requireOpen(run: PayrollRunDoc) {
  if (run.status === "imported") return;
  throw new AppError(
    "CONFLICT",
    run.status === "approved"
      ? `${run.runNumber} is approved — undo the approval to change who is on it.`
      : `${run.runNumber} is ${run.status.replace("_", " ")} — who is on it can't change now.`,
  );
}

/** Each refused row and its reasons. */
function problemsOf(rows: Array<{ rowNo: number; line: ManualPayrollLine; check: ManualLineCheck }>): ManualRowProblem[] {
  return rows.filter((r) => r.check.problems.length).map((r) => ({ rowNo: r.rowNo, name: r.line.name, problems: r.check.problems }));
}

/**
 * The finance records a line points at, where they exist: the employee with its code (so a person's page counts their
 * pay) and the department with its name (so the department report does). Neither is required — an organization not on
 * HRMS may have no employees here at all — and a code two employees share links nobody rather than the wrong one.
 */
async function linksFor(orgId: string, lines: ManualPayrollLine[]) {
  const codes = [...new Set(lines.map((l) => l.employeeCode.trim()).filter(Boolean))];
  const employees = codes.length
    ? await Employee.find({ organizationId: oid(orgId), employeeCode: { $in: codes } }).select("_id employeeCode departmentId").lean()
    : [];
  const byCode = new Map<string, (typeof employees)[number]>();
  const shared = new Set<string>();
  for (const e of employees) {
    const k = String(e.employeeCode).trim().toLowerCase();
    if (byCode.has(k)) shared.add(k); else byCode.set(k, e);
  }
  for (const k of shared) byCode.delete(k);
  const wantsDepartment = lines.some((l) => l.departmentName.trim());
  const departments = wantsDepartment ? await Department.find({ organizationId: oid(orgId) }).select("_id name").lean() : [];
  const deptByName = new Map(departments.map((d) => [String(d.name).trim().toLowerCase(), d]));
  return {
    employee: (code: string) => byCode.get(code.trim().toLowerCase()),
    department: (name: string) => deptByName.get(name.trim().toLowerCase()),
  };
}

/** A checked line as stored on the run. Its HRMS ids say "manual": unique, and never an id HRMS could have sent. */
function lineDoc(line: ManualPayrollLine, check: ManualLineCheck, links: Awaited<ReturnType<typeof linksFor>>, id = new Types.ObjectId()) {
  const employee = links.employee(line.employeeCode);
  const department = links.department(line.departmentName);
  return {
    _id: id,
    hrmsPayslipId: `manual:${id}`,
    hrmsEmployeeId: `manual:${id}`,
    employeeId: employee?._id ?? null,
    employeeCode: line.employeeCode,
    name: line.name,
    designation: line.designation,
    currency: check.currency,
    departmentId: department?._id ?? employee?.departmentId ?? null,
    departmentName: line.departmentName,
    earnings: [{ label: MANUAL_GROSS_LABEL, amountMinor: check.grossMinor }],
    deductions: check.deductions.map((d) => ({ label: d.label, amountMinor: d.amountMinor })),
    grossMinor: check.grossMinor,
    deductionsMinor: check.deductionsMinor,
    // "From HRMS" in name only: on a manual line it is the net as entered — gross less deductions.
    netFromHrmsMinor: check.netMinor,
    adjustmentsMinor: 0,
    payableMinor: check.netMinor,
    amountPaidMinor: 0,
    bank: { iban: "", accountNumber: line.accountNumber, bankName: line.bankName, nameInBank: "", ifsc: line.ifsc },
    // Paid by transfer, or by cash without bank details — nobody is held for want of them (2026-11-05).
    payable: true,
  };
}

/** The run's totals from its lines: gross, deductions and net as entered, and payable and balance from them. */
function settleTotals(run: PayrollRunDoc) {
  run.hrmsGrossMinor = run.lines.reduce((a, l) => a + l.grossMinor, 0);
  run.hrmsDeductionsMinor = run.lines.reduce((a, l) => a + l.deductionsMinor, 0);
  run.hrmsNetMinor = run.lines.reduce((a, l) => a + l.netFromHrmsMinor, 0);
  recalculate(run as unknown as RecalcRun);
}

/**
 * Checks `lines` against each other and the people already on the run, then puts the good ones on it (unsaved).
 * `partial`: an import — the good rows go on and the rest are reported. Otherwise one bad row refuses them all.
 */
async function putLines(orgId: string, run: PayrollRunDoc, lines: ManualPayrollLine[], opts: { partial: boolean }) {
  const checked = checkManualPayrollRows(lines, run.currency ?? "", run.lines.map((l) => l.employeeCode ?? ""));
  const problems = problemsOf(checked.rows);
  if (problems.length && !opts.partial) {
    throw new AppError("VALIDATION_ERROR", problems.map((p) => p.problems.join("; ")).join(" · "), { problems });
  }
  const good = checked.rows.filter((r) => !r.check.problems.length);
  const links = await linksFor(orgId, good.map((r) => r.line));
  for (const r of good) run.lines.push({ ...lineDoc(r.line, r.check, links), status: "pending", holdReason: "" } as never);
  settleTotals(run);
  return { created: good.length, problems };
}

const runFigures = (run: PayrollRunDoc) => ({
  runId: String(run._id),
  runNumber: run.runNumber,
  employeeCount: run.lines.length,
  byCurrency: summariseByCurrency(run.lines, run.currency ?? ""),
});

/**
 * People onto a month still open: one typed (`partial` off — refused with what is wrong), or an imported sheet
 * (`partial` on — the good rows added, the others listed with why). Nothing is added to a month already approved.
 */
export async function addManualLines(orgId: string, runId: string, input: { lines: ManualPayrollLineInput[]; partial?: boolean }) {
  const run = await loadManualRun(orgId, runId);
  requireOpen(run);
  const lines = input.lines.map((l) => manualPayrollLineSchema.parse(l));
  if (!lines.length) throw new AppError("VALIDATION_ERROR", "Nobody to add");
  const added = await putLines(orgId, run, lines, { partial: Boolean(input.partial) });
  if (added.created) await run.save();
  return {
    ...runFigures(run),
    created: added.created,
    problems: added.problems,
    message: added.problems.length
      ? `${added.created} added; ${added.problems.length} row(s) left out — see why against each.`
      : `${added.created} added to ${run.runNumber}`,
  };
}

/** One person's line changed, while the month is open. Their hold, if any, stays. */
export async function updateManualLine(orgId: string, runId: string, lineId: string, input: ManualPayrollLineInput) {
  const run = await loadManualRun(orgId, runId);
  requireOpen(run);
  const line = run.lines.find((l) => String(l._id) === lineId);
  if (!line) throw new AppError("NOT_FOUND", "That person is not on this run");
  const parsed = manualPayrollLineSchema.parse(input);
  const others = run.lines.filter((l) => String(l._id) !== lineId).map((l) => l.employeeCode ?? "");
  const checked = checkManualPayrollRows([parsed], run.currency ?? "", others);
  const problems = problemsOf(checked.rows);
  if (problems.length) throw new AppError("VALIDATION_ERROR", problems[0]!.problems.join("; "), { problems });

  const links = await linksFor(orgId, [parsed]);
  const { _id: _keep, ...fields } = lineDoc(parsed, checked.rows[0]!.check, links, line._id as Types.ObjectId);
  line.set(fields);
  settleTotals(run);
  await run.save();
  return { ...runFigures(run), lineId, message: `${line.name} updated` };
}

/** One person off a month still open. */
export async function removeManualLine(orgId: string, runId: string, lineId: string) {
  const run = await loadManualRun(orgId, runId);
  requireOpen(run);
  const line = run.lines.find((l) => String(l._id) === lineId);
  if (!line) throw new AppError("NOT_FOUND", "That person is not on this run");
  const name = line.name;
  run.lines.pull(line._id);
  settleTotals(run);
  await run.save();
  return { ...runFigures(run), lineId, message: `${name} removed from ${run.runNumber}` };
}

/** A month made by mistake, deleted — only before approval, so nothing of it was ever paid or posted. */
export async function deleteManualRun(orgId: string, runId: string) {
  const run = await loadManualRun(orgId, runId);
  requireOpen(run);
  if (run.payments.length || run.amountPaidMinor > 0) {
    throw new AppError("CONFLICT", `${run.runNumber} has payments — it can't be deleted.`);
  }
  await PayrollRun.deleteOne({ _id: run._id, organizationId: oid(orgId) });
  return { runNumber: run.runNumber, message: `${run.runNumber} (${run.period}) deleted` };
}
