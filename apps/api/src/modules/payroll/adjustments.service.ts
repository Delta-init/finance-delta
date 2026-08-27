import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { hrmsClient, type HrmsAdjustmentOutcome } from "../../lib/hrms-client";
import { CommissionRecord } from "../commission/commission-record.model";
import { Employee } from "../employee/employee.model";
import { User } from "../user/user.model";
import { PayrollRun, type PayrollRunDoc } from "./payroll-run.model";
import { toMinor, formatMinor } from "./money";
import { recalculate, type RecalcRun } from "./recalculate";

const oid = (id: string) => new Types.ObjectId(id);

/**
 * Step two of the handover: what accounts add to, or take off, a month.
 *
 * Two sources feed it. Commission is pulled automatically, because finance
 * already knows what it owes each salesperson and making somebody retype those
 * figures into a payroll screen would be both tedious and a chance to get them
 * wrong. Everything else is typed by hand.
 *
 * Either way the item is written back to HRMS, so the payslip an employee
 * downloads matches the money that leaves the bank. Keeping additions only on
 * this side would mean no payslip in the company was true.
 */

const STATUSES_OPEN_TO_ADJUSTMENT = ["imported", "additions"];

function requireOpen(run: PayrollRunDoc) {
  if (!STATUSES_OPEN_TO_ADJUSTMENT.includes(run.status)) {
    throw new AppError(
      "CONFLICT",
      `${run.runNumber} is ${run.status.replace("_", " ")} and can no longer be adjusted.`,
    );
  }
}

async function loadRun(orgId: string, runId: string) {
  const run = await PayrollRun.findOne({ _id: oid(runId), organizationId: oid(orgId) });
  if (!run) throw new AppError("NOT_FOUND", "Payroll run not found");
  return run;
}

/**
 * A stable, unique id for one adjustment.
 *
 * Derived from the run and the line rather than random, so that a request
 * rebuilt after a crash produces the same id and HRMS recognises it as the same
 * item. The counter keeps two additions to one person distinct.
 */
function makeExternalId(runNumber: string, lineId: string, seq: number): string {
  return `${runNumber}:${lineId}:${seq}`;
}

/**
 * Fold HRMS's answer back into the run.
 *
 * The important field is `appliedAmount`. HRMS only recovers what a month can
 * afford, so a deduction may come back smaller than it was sent — and the run
 * has to hold what happened, not what was asked for.
 */
function absorbOutcomes(run: PayrollRunDoc, outcomes: HrmsAdjustmentOutcome[]) {
  const byExternal = new Map(outcomes.map((o) => [o.externalId, o]));
  for (const adj of run.adjustments) {
    const outcome = byExternal.get(adj.externalId);
    if (!outcome) continue;
    adj.recoveredMinor = toMinor(outcome.appliedAmount);
    adj.outstandingMinor = toMinor(outcome.outstanding);
    adj.syncedAt = new Date();
  }
  for (const line of run.lines) {
    const outcome = outcomes.find((o) => o.employeeId === line.hrmsEmployeeId);
    if (outcome) line.netFromHrmsMinor = toMinor(outcome.netAfter) - line.adjustmentsMinor;
  }
}

export interface AddAdjustmentInput {
  lineId: string;
  kind: "addition" | "deduction";
  label: string;
  amountMinor: number;
  notes?: string;
}

export async function addAdjustments(
  orgId: string,
  runId: string,
  inputs: AddAdjustmentInput[],
  actor: { userId: string },
) {
  const run = await loadRun(orgId, runId);
  requireOpen(run);
  if (!inputs.length) throw new AppError("VALIDATION_ERROR", "Nothing to add");

  const user = await User.findById(oid(actor.userId)).select("name").lean();
  const staged: Array<{ externalId: string; employeeId: string; kind: "payment" | "deduction"; label: string; amount: number; notes?: string }> = [];

  for (const input of inputs) {
    const line = run.lines.find((l) => String(l._id) === input.lineId);
    if (!line) throw new AppError("NOT_FOUND", `No such person on this run: ${input.lineId}`);
    if (input.amountMinor <= 0) throw new AppError("VALIDATION_ERROR", `"${input.label}" must be a positive amount`);

    const seq = run.adjustments.filter((a) => String(a.lineId) === input.lineId).length + 1;
    const externalId = makeExternalId(run.runNumber, String(line._id), seq);

    run.adjustments.push({
      externalId,
      hrmsEmployeeId: line.hrmsEmployeeId,
      lineId: line._id,
      kind: input.kind,
      source: "manual",
      label: input.label,
      amountMinor: input.amountMinor,
      notes: input.notes ?? "",
      commissionRecordIds: [],
      recoveredMinor: input.kind === "addition" ? input.amountMinor : 0,
      outstandingMinor: 0,
      syncedAt: null,
      createdById: oid(actor.userId),
      createdByName: user?.name ?? "",
    } as never);

    staged.push({
      externalId,
      employeeId: line.hrmsEmployeeId,
      kind: input.kind === "addition" ? "payment" : "deduction",
      label: input.label,
      amount: input.amountMinor / 100,
      notes: input.notes,
    });
  }

  // HRMS first. If it refuses, nothing is saved here either, and the run is
  // left exactly as it was rather than holding an addition the payslip does not
  // know about.
  const result = await hrmsClient.applyAdjustments(run.hrmsOrgId, run.period, staged);

  absorbOutcomes(run, result.outcomes);
  recalculate(run as unknown as RecalcRun);
  await run.save();

  return summariseOutcomes(run, result.outcomes);
}

/**
 * Pull every commission this run's people have earned and not yet been paid.
 *
 * Commission is currently settled by marking records paid against an expense,
 * outside payroll. Routing it through the run closes that loop and removes the
 * double-payment risk of the same commission being paid both ways.
 */
export async function pullCommissions(orgId: string, runId: string, actor: { userId: string }) {
  const run = await loadRun(orgId, runId);
  requireOpen(run);

  // Only people this run can actually reach: a commission owed to somebody not
  // on this payroll is not this run's to pay.
  const employees = await Employee.find({
    organizationId: oid(orgId),
    hrmsOrgId: run.hrmsOrgId,
    hrmsEmployeeId: { $in: run.lines.map((l) => l.hrmsEmployeeId) },
    userId: { $ne: null },
  }).lean();

  if (!employees.length) {
    return { pulled: 0, message: "Nobody on this run is linked to a finance login, so no commission could be matched.", outcomes: [] };
  }

  const userToEmployee = new Map(employees.map((e) => [String(e.userId), e]));
  const alreadyPulled = new Set(
    run.adjustments.filter((a) => a.source === "commission").flatMap((a) => a.commissionRecordIds.map(String)),
  );

  const records = await CommissionRecord.find({
    organizationId: oid(orgId),
    salespersonId: { $in: employees.map((e) => e.userId) },
    status: "earned",
  }).lean();

  const fresh = records.filter((r) => !alreadyPulled.has(String(r._id)));
  if (!fresh.length) {
    return { pulled: 0, message: "No unpaid commission is outstanding for anybody on this run.", outcomes: [] };
  }

  // One addition per person, not per invoice. A payslip listing forty
  // commission lines is unreadable, and the individual records stay linked on
  // the adjustment for anyone who needs the breakdown.
  const byPerson = new Map<string, typeof fresh>();
  for (const r of fresh) {
    const key = String(r.salespersonId);
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key)!.push(r);
  }

  const user = await User.findById(oid(actor.userId)).select("name").lean();
  const staged: Array<{ externalId: string; employeeId: string; kind: "payment"; label: string; amount: number }> = [];

  for (const [userId, rows] of byPerson) {
    const employee = userToEmployee.get(userId);
    if (!employee) continue;
    const line = run.lines.find((l) => l.hrmsEmployeeId === employee.hrmsEmployeeId);
    if (!line) continue;

    const amountMinor = rows.reduce((a, r) => a + r.commissionMinor, 0);
    if (amountMinor <= 0) continue;

    const seq = run.adjustments.filter((a) => String(a.lineId) === String(line._id)).length + 1;
    const externalId = makeExternalId(run.runNumber, String(line._id), seq);
    const label = `Sales commission (${rows.length} invoice${rows.length === 1 ? "" : "s"})`;

    run.adjustments.push({
      externalId,
      hrmsEmployeeId: line.hrmsEmployeeId,
      lineId: line._id,
      kind: "addition",
      source: "commission",
      label,
      amountMinor,
      notes: rows.map((r) => r.invoiceNumber).join(", ").slice(0, 500),
      commissionRecordIds: rows.map((r) => r._id),
      recoveredMinor: amountMinor,
      outstandingMinor: 0,
      syncedAt: null,
      createdById: oid(actor.userId),
      createdByName: user?.name ?? "",
    } as never);

    staged.push({ externalId, employeeId: line.hrmsEmployeeId, kind: "payment", label, amount: amountMinor / 100 });
  }

  if (!staged.length) {
    return { pulled: 0, message: "No commission could be matched to anybody on this run.", outcomes: [] };
  }

  const result = await hrmsClient.applyAdjustments(run.hrmsOrgId, run.period, staged);

  absorbOutcomes(run, result.outcomes);
  recalculate(run as unknown as RecalcRun);
  await run.save();

  // The commission records themselves are NOT marked paid here. They are paid
  // when the payroll is, and marking them now would report money as paid that
  // is still sitting in a run nobody has transferred.
  return {
    pulled: staged.length,
    message: `${staged.length} commission payment(s) added, ${formatMinor(staged.reduce((a, s) => a + toMinor(s.amount), 0), run.currency)} in total.`,
    ...summariseOutcomes(run, result.outcomes),
  };
}

export async function removeAdjustment(orgId: string, runId: string, externalId: string) {
  const run = await loadRun(orgId, runId);
  requireOpen(run);

  const index = run.adjustments.findIndex((a) => a.externalId === externalId);
  if (index === -1) throw new AppError("NOT_FOUND", "No such adjustment on this run");

  // HRMS first again: if it refuses, this side is untouched and the two stay in
  // step. Removing here first would leave a payslip carrying money the run no
  // longer knows about.
  await hrmsClient.removeAdjustment(run.hrmsOrgId, run.period, externalId);

  run.adjustments.splice(index, 1);
  recalculate(run as unknown as RecalcRun);
  await run.save();
  return { message: "Adjustment removed", externalId };
}

/**
 * Turns HRMS's answer into something worth reading.
 *
 * The point of this is the surprise: adding money can change deductions,
 * because a bonus can make a loan instalment affordable that last month was
 * carried forward. So a person who was given 500 may see their net rise by 300.
 * Saying so plainly here is the difference between accounts trusting the
 * system and accounts thinking it ate their money.
 */
function summariseOutcomes(run: PayrollRunDoc, outcomes: HrmsAdjustmentOutcome[]) {
  const notes: string[] = [];
  for (const o of outcomes) {
    const line = run.lines.find((l) => l.hrmsEmployeeId === o.employeeId);
    const who = line?.name ?? o.employeeId;
    const asked = toMinor(o.amount);
    const applied = toMinor(o.appliedAmount);
    const movement = toMinor(o.netAfter) - toMinor(o.netBefore);

    if (o.kind === "deduction" && applied < asked) {
      notes.push(
        `${who}: only ${formatMinor(applied, run.currency)} of the ${formatMinor(asked, run.currency)} ` +
          `deduction could be recovered this month; ${formatMinor(toMinor(o.outstanding), run.currency)} carries to next month.`,
      );
    }
    if (o.kind === "payment" && movement !== asked) {
      notes.push(
        `${who}: ${formatMinor(asked, run.currency)} was added but net pay moved by ` +
          `${formatMinor(movement, run.currency)} — the difference went to loan or advance recovery that the month can now afford.`,
      );
    }
  }
  return {
    runId: String(run._id),
    adjustmentsMinor: run.adjustmentsMinor,
    payableMinor: run.payableMinor,
    outcomes,
    notes,
  };
}
