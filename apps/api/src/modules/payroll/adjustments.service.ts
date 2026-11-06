import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { hrmsClient, type HrmsAdjustmentOutcome } from "../../lib/hrms-client";
import { CommissionRecord } from "../commission/commission-record.model";
import { CrmCommissionPayout } from "../crm-commission/crm-commission-payout.model";
import { CsCommissionPayout } from "../cs-commission/cs-commission-payout.model";
import { periodLabel } from "../cs-commission/cs-commission.service";
import { fromRoot, slabsFromRoot } from "../crm-commission/crm-commission.service";
import { Employee } from "../employee/employee.model";
import { User } from "../user/user.model";
import { PayrollRun, type PayrollRunDoc } from "./payroll-run.model";
import { toMinor, formatMinor } from "./money";
import { recalculate, lineAdjustmentTotal, type RecalcAdjustment, type RecalcRun } from "./recalculate";
import { isAttendance, slabDifference } from "./slab";

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

/**
 * Pulling commission and salary slabs: only before approval. They rewrite items across everybody on the run, the
 * people already paid among them.
 */
function requireOpen(run: PayrollRunDoc) {
  if (!STATUSES_OPEN_TO_ADJUSTMENT.includes(run.status)) {
    throw new AppError(
      "CONFLICT",
      `${run.runNumber} is ${run.status.replace("_", " ")} and can no longer be adjusted.`,
    );
  }
}

/**
 * Approved, and not yet paid in full: one person's additions and deductions can still change (the user, 2026-11-04:
 * "edit this payroll after the approve also … same as before the approval, for specific people"). A payslip paid in
 * full is what the bank sent, and stays. Somebody paid in part (the user, 2026-11-06: "add or deduct … need to appear
 * on the part payment also") can still change — as long as something is left to pay them: a deduction under what is
 * still owed, an addition taken off only if that holds. Their payslip is closed in HRMS by the payment that pays the
 * last of it, so pay brought down to what has been paid would leave it open for ever.
 */
const STATUSES_OPEN_AFTER_APPROVAL = ["approved", "partially_paid"];

function requireAdjustable(run: PayrollRunDoc) {
  if (!STATUSES_OPEN_TO_ADJUSTMENT.includes(run.status) && !STATUSES_OPEN_AFTER_APPROVAL.includes(run.status)) {
    throw new AppError(
      "CONFLICT",
      `${run.runNumber} is ${run.status.replace("_", " ")} and can no longer be adjusted.`,
    );
  }
}

type RunLineDoc = PayrollRunDoc["lines"][number];

/** Paid something, not all of it. */
const isPartPaid = (line: RunLineDoc) => line.status !== "paid" && (line.amountPaidMinor ?? 0) > 0;

function requireLineAdjustable(run: PayrollRunDoc, line: RunLineDoc) {
  if (!STATUSES_OPEN_AFTER_APPROVAL.includes(run.status)) return;
  if (line.status === "paid" || (isPartPaid(line) && line.payableMinor - line.amountPaidMinor <= 0)) {
    throw new AppError("CONFLICT", `${line.name} has been paid in full — reverse their payment first to change their pay.`);
  }
}

/** Somebody paid in part keeps something still to pay, whatever this change does to their pay. */
function requireStillOwed(run: PayrollRunDoc, line: RunLineDoc, payableAfterMinor: number, what: string) {
  if (!isPartPaid(line) || payableAfterMinor - line.amountPaidMinor > 0) return;
  const cur = line.currency || run.currency;
  const owed = line.payableMinor - line.amountPaidMinor;
  throw new AppError(
    "CONFLICT",
    `${line.name} has been paid ${formatMinor(line.amountPaidMinor, cur)} and is still owed ${formatMinor(owed, cur)}: ${what} would leave nothing to pay them, `
      + `and only a payment closes their payslip. Keep it under ${formatMinor(owed, cur)}, or reverse their payment first.`,
  );
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
 * The next counter for a person's item: one past the highest they have, not one past how many. After a removal those
 * differ, and a counter already in use makes HRMS overwrite that item (it upserts on the id) — a manual addition taken
 * off and another added would have replaced a commission payment on the payslip.
 */
function nextSeq(run: PayrollRunDoc, lineId: string): number {
  const mine = run.adjustments.filter((a) => String(a.lineId) === lineId);
  return Math.max(mine.length, ...mine.map((a) => Number(a.externalId.split(":").pop()) || 0)) + 1;
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
    if (!outcome) continue;
    // HRMS reports the net *including* the adjustment it just applied, so the
    // run's own adjustments have to come back off to leave HRMS's own figure.
    // Computed from run.adjustments rather than read off the line, whose
    // adjustmentsMinor is still the total from before this item landed —
    // reading it there added a commission payment to the payable twice.
    const mine = lineAdjustmentTotal(run.adjustments as unknown as RecalcAdjustment[], line._id);
    line.netFromHrmsMinor = toMinor(outcome.netAfter) - mine;
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
  requireAdjustable(run);
  if (!inputs.length) throw new AppError("VALIDATION_ERROR", "Nothing to add");
  const afterApproval = STATUSES_OPEN_AFTER_APPROVAL.includes(run.status);

  const user = await User.findById(oid(actor.userId)).select("name").lean();
  const staged: Array<{ externalId: string; employeeId: string; kind: "payment" | "deduction"; label: string; amount: number; notes?: string }> = [];
  // What these items do to each person's pay, so somebody paid in part is checked against all of theirs at once.
  const change = new Map<string, number>();

  for (const input of inputs) {
    const line = run.lines.find((l) => String(l._id) === input.lineId);
    if (!line) throw new AppError("NOT_FOUND", `No such person on this run: ${input.lineId}`);
    requireLineAdjustable(run, line);
    if (input.amountMinor <= 0) throw new AppError("VALIDATION_ERROR", `"${input.label}" must be a positive amount`);
    const moved = (change.get(input.lineId) ?? 0) + (input.kind === "addition" ? input.amountMinor : -input.amountMinor);
    change.set(input.lineId, moved);
    requireStillOwed(run, line, line.payableMinor + moved, "this deduction");

    const externalId = makeExternalId(run.runNumber, String(line._id), nextSeq(run, input.lineId));

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
      afterApproval,
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

  // HRMS rebuilds the payslip as it applies an item, and the rebuilt one could still take somebody paid in part down
  // to what they have been paid. Then the items come back off HRMS and nothing here is saved.
  const emptied = run.lines.filter((l) => change.has(String(l._id)) && isPartPaid(l) && l.payableMinor - l.amountPaidMinor <= 0);
  if (emptied.length) {
    for (const item of staged) await hrmsClient.removeAdjustment(run.hrmsOrgId, run.period, item.externalId).catch(() => undefined);
    throw new AppError(
      "CONFLICT",
      `${emptied.map((l) => l.name).join(", ")} would be left with nothing to pay after HRMS worked out the payslip again — nothing was added. Use a smaller amount.`,
    );
  }
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
  const user = await User.findById(oid(actor.userId)).select("name").lean();
  const staged: Array<{ externalId: string; employeeId: string; kind: "payment"; label: string; amount: number }> = [];
  const notes: string[] = [];

  // Finance's own commission records — salespeople linked to a finance login.
  const records = await stageCommissionRecords(orgId, run, actor, user?.name ?? "", staged);
  if (records.note) notes.push(records.note);
  // The sales CRMs' commission (2026-11-01: "commission through payroll") — approved on the CRM commission page.
  const crm = await stageCrmCommission(orgId, run, actor, user?.name ?? "", staged);
  if (crm.note) notes.push(crm.note);
  // The CS Portal's commission (2026-11-03) — approved on the CS commission page.
  const cs = await stageCsCommission(orgId, run, actor, user?.name ?? "", staged);
  if (cs.note) notes.push(cs.note);

  if (!staged.length) {
    return { pulled: 0, message: notes.join(" ") || "No unpaid commission is outstanding for anybody on this run.", outcomes: [] };
  }

  const result = await hrmsClient.applyAdjustments(run.hrmsOrgId, run.period, staged);

  absorbOutcomes(run, result.outcomes);
  recalculate(run as unknown as RecalcRun);
  await run.save();
  // The CRM commission is claimed for this run once HRMS has it on the payslips; nothing is marked paid until the run
  // pays the line (see settleCommissions).
  if (crm.payoutIds.length) {
    await CrmCommissionPayout.updateMany({ _id: { $in: crm.payoutIds }, payrollRunId: null }, { $set: { payrollRunId: run._id, payrollRunNumber: run.runNumber } });
  }
  if (cs.payoutIds.length) {
    await CsCommissionPayout.updateMany({ _id: { $in: cs.payoutIds }, payrollRunId: null }, { $set: { payrollRunId: run._id, payrollRunNumber: run.runNumber } });
  }

  // The commission records themselves are NOT marked paid here. They are paid
  // when the payroll is, and marking them now would report money as paid that
  // is still sitting in a run nobody has transferred.
  return {
    pulled: staged.length,
    message: [`${staged.length} commission payment(s) added, ${formatMinor(staged.reduce((a, s) => a + toMinor(s.amount), 0), run.currency)} in total.`, ...notes].join(" "),
    ...summariseOutcomes(run, result.outcomes),
  };
}

type Staged = Array<{ externalId: string; employeeId: string; kind: "payment"; label: string; amount: number }>;

/** Finance's own commission records for this run's people, one addition per person. */
async function stageCommissionRecords(orgId: string, run: PayrollRunDoc, actor: { userId: string }, actorName: string, staged: Staged): Promise<{ note: string }> {
  // Only people this run can actually reach: a commission owed to somebody not
  // on this payroll is not this run's to pay.
  const employees = await Employee.find({
    organizationId: oid(orgId),
    hrmsOrgId: run.hrmsOrgId,
    hrmsEmployeeId: { $in: run.lines.map((l) => l.hrmsEmployeeId) },
    userId: { $ne: null },
  }).lean();
  if (!employees.length) return { note: "" };

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
  if (!fresh.length) return { note: "" };

  // One addition per person, not per invoice. A payslip listing forty
  // commission lines is unreadable, and the individual records stay linked on
  // the adjustment for anyone who needs the breakdown.
  const byPerson = new Map<string, typeof fresh>();
  for (const r of fresh) {
    const key = String(r.salespersonId);
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key)!.push(r);
  }
  for (const [userId, rows] of byPerson) {
    const employee = userToEmployee.get(userId);
    if (!employee) continue;
    const line = run.lines.find((l) => l.hrmsEmployeeId === employee.hrmsEmployeeId);
    if (!line) continue;
    const amountMinor = rows.reduce((a, r) => a + r.commissionMinor, 0);
    if (amountMinor <= 0) continue;
    const externalId = makeExternalId(run.runNumber, String(line._id), nextSeq(run, String(line._id)));
    const label = `Sales commission (${rows.length} invoice${rows.length === 1 ? "" : "s"})`;
    run.adjustments.push({
      externalId, hrmsEmployeeId: line.hrmsEmployeeId, lineId: line._id, kind: "addition", source: "commission", label, amountMinor,
      notes: rows.map((r) => r.invoiceNumber).join(", ").slice(0, 500), commissionRecordIds: rows.map((r) => r._id),
      recoveredMinor: amountMinor, outstandingMinor: 0, syncedAt: null, createdById: oid(actor.userId), createdByName: actorName,
    } as never);
    staged.push({ externalId, employeeId: line.hrmsEmployeeId, kind: "payment", label, amount: amountMinor / 100 });
  }
  return { note: "" };
}

const monthName = (m: string) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));

/**
 * The sales CRMs' commission for this run's people (2026-11-01: "commission through payroll"): every month a manager
 * approved on the CRM commission page and nobody has paid — this run's month and any before it — found on the run by
 * the person's CRM email (an employee's email here), in the line's currency. One addition per CRM month, at the
 * approved figure.
 */
async function stageCrmCommission(orgId: string, run: PayrollRunDoc, actor: { userId: string }, actorName: string, staged: Staged): Promise<{ note: string; payoutIds: Types.ObjectId[] }> {
  const payouts = await CrmCommissionPayout.find({ state: "approved", payrollRunId: null, month: { $lte: run.period } }).sort({ month: 1 }).lean<any[]>();
  if (!payouts.length) return { note: "", payoutIds: [] };
  // Each person's CRM email, from Root, a month at a time.
  const emailOf = new Map<string, string>();
  const unread: string[] = [];
  for (const month of [...new Set(payouts.map((p) => p.month as string))]) {
    try {
      for (const c of await fromRoot(month)) for (const p of c.people ?? []) if (p.email) emailOf.set(`${c.code}:${month}:${p.userId}`, p.email.toLowerCase());
    } catch {
      unread.push(monthName(month));
    }
  }
  const emails = [...new Set(payouts.map((p) => emailOf.get(String(p.key))).filter(Boolean) as string[])];
  const employees = emails.length ? await Employee.find({
    organizationId: oid(orgId), hrmsOrgId: run.hrmsOrgId, email: { $in: emails }, hrmsEmployeeId: { $in: run.lines.map((l) => l.hrmsEmployeeId) },
  }).lean() : [];
  const employeeOf = new Map(employees.map((e) => [String(e.email).toLowerCase(), e]));
  const payoutIds: Types.ObjectId[] = [];
  const missed: string[] = [];
  for (const p of payouts) {
    const email = emailOf.get(String(p.key));
    const employee = email ? employeeOf.get(email) : undefined;
    const line = employee ? run.lines.find((l) => l.hrmsEmployeeId === employee.hrmsEmployeeId) : undefined;
    const lineCurrency = (line?.currency || run.currency || "AED").toUpperCase();
    if (!line || lineCurrency !== String(p.currency || "AED").toUpperCase()) {
      missed.push(`${p.personName} (${p.crmName || p.crm}, ${monthName(p.month)})`);
      continue;
    }
    if (p.amountMinor <= 0) continue;
    const externalId = makeExternalId(run.runNumber, String(line._id), nextSeq(run, String(line._id)));
    const label = `Sales commission (CRM) — ${p.crmName || p.crm}, ${monthName(p.month)}`;
    run.adjustments.push({
      externalId, hrmsEmployeeId: line.hrmsEmployeeId, lineId: line._id, kind: "addition", source: "crm_commission", label, amountMinor: p.amountMinor,
      notes: `Approved by ${p.approvedByName || "a manager"}`.slice(0, 500), commissionRecordIds: [], crmPayoutIds: [p._id],
      recoveredMinor: p.amountMinor, outstandingMinor: 0, syncedAt: null, createdById: oid(actor.userId), createdByName: actorName,
    } as never);
    staged.push({ externalId, employeeId: line.hrmsEmployeeId, kind: "payment", label, amount: p.amountMinor / 100 });
    payoutIds.push(p._id);
  }
  const notes = [
    ...(missed.length ? [`Approved CRM commission not on this run (no employee here with their CRM email, or another currency): ${missed.join(", ")}.`] : []),
    ...(unread.length ? [`The CRMs' people couldn't be read from Root for ${unread.join(", ")} — pull again later.`] : []),
  ];
  return { note: notes.join(" "), payoutIds };
}

/**
 * Put this run's salespeople on their CRM salary slab (2026-11-01: the slab pulled in finance, not HRMS). Each person
 * Root has on a slab this month — found on the run by their CRM email, in the line's currency — gets the difference
 * between the slab and the salary HR sent (see slabDifference), as one addition or deduction written back to their
 * payslip. HR's figures (contract salary, how much of it the payslip pays) come from HRMS at the time of the pull. Pulled again,
 * a person's earlier slab item is replaced when the figure moved, and taken off when Root no longer has them on a slab
 * — unless their CRM couldn't be read, when it stays as it was.
 */
export async function pullSlabSalaries(orgId: string, runId: string, actor: { userId: string }) {
  const run = await loadRun(orgId, runId);
  requireOpen(run);
  const [root, batch] = await Promise.all([slabsFromRoot(run.period), hrmsClient.payrollBatch(run.hrmsOrgId, run.period)]);
  if (!batch.lines.some((l) => l.salary)) {
    throw new AppError("UNAVAILABLE", "HRMS needs updating before salary slabs can be pulled — it doesn't send each payslip's contract salary yet.");
  }
  const salaryOf = new Map(batch.lines.map((l) => [l.payslipId, l.salary]));
  const user = await User.findById(oid(actor.userId)).select("name").lean();
  const unread = new Set(root.failures.map((f) => f.crm));

  // Each person on a slab by their CRM email; somebody on two CRMs' slabs can't be told apart, so is left for a person.
  const byEmail = new Map<string, typeof root.people>();
  for (const p of root.people) {
    const email = (p.email ?? "").trim().toLowerCase();
    if (!email) continue;
    byEmail.set(email, [...(byEmail.get(email) ?? []), p]);
  }
  const employees = byEmail.size ? await Employee.find({
    organizationId: oid(orgId), hrmsOrgId: run.hrmsOrgId, email: { $in: [...byEmail.keys()] }, hrmsEmployeeId: { $in: run.lines.map((l) => l.hrmsEmployeeId) },
  }).lean() : [];

  type Want = { line: (typeof run.lines)[number]; crm: string; kind: "addition" | "deduction"; amountMinor: number; label: string; notes: string };
  const wanted = new Map<string, Want | null>();
  const missed: string[] = [];
  for (const e of employees) {
    const on = byEmail.get(String(e.email).toLowerCase()) ?? [];
    const line = run.lines.find((l) => l.hrmsEmployeeId === e.hrmsEmployeeId);
    if (!line) continue;
    if (on.length > 1) { missed.push(`${line.name} (on ${on.map((p) => p.crmName).join(" and ")}'s slabs)`); continue; }
    const p = on[0]!;
    const currency = (line.currency || run.currency || "AED").toUpperCase();
    if (currency !== String(p.currency || "AED").toUpperCase()) { missed.push(`${line.name} (paid in ${currency}, ${p.crmName}'s slab is ${p.currency})`); continue; }
    const salary = salaryOf.get(line.hrmsPayslipId);
    const monthly = toMinor(salary?.monthly ?? 0), paid = toMinor(salary?.paid ?? 0), slab = toMinor(p.salary);
    if (monthly <= 0) { missed.push(`${line.name} (no contract salary in HRMS)`); continue; }
    const attendance = line.deductions.filter((d) => isAttendance(d.label));
    const { onSlip, hrAttendance, slabAttendance, difference } = slabDifference({ monthly, paid, slab, attendance: attendance.map((d) => d.amountMinor) });
    const f = (m: number) => formatMinor(m, currency);
    wanted.set(String(line._id), difference === 0 ? null : {
      line, crm: p.crm, kind: difference > 0 ? "addition" : "deduction", amountMinor: Math.abs(difference),
      label: `Salary slab — ${p.crmName} ${p.level}, ${f(slab)}`,
      notes: [`Contract ${f(monthly)}, this payslip ${f(paid)} → ${f(onSlip)} on the slab`,
        ...(attendance.length ? [`${attendance.map((d) => d.label).join(", ")}: ${f(hrAttendance)} → ${f(slabAttendance)}`] : [])].join("; ").slice(0, 500),
    });
  }

  // What changes: an item whose figure moved goes and its replacement comes; an item for somebody no longer on a slab
  // goes, unless their CRM couldn't be read this time.
  const existing = run.adjustments.filter((a) => a.source === "crm_slab");
  const same = (a: (typeof existing)[number], w: Want) => a.kind === w.kind && a.amountMinor === w.amountMinor && a.label === w.label;
  const drop = existing.filter((a) => {
    const lineId = String(a.lineId);
    if (!wanted.has(lineId)) return !unread.has(a.crm ?? "");
    const w = wanted.get(lineId);
    return !w || !existing.some((x) => String(x.lineId) === lineId && same(x, w)) || existing.filter((x) => String(x.lineId) === lineId).length > 1;
  });
  // HRMS first, item by item, so a refusal leaves both sides saying the same; the run is saved once they're gone.
  for (const a of drop) {
    await hrmsClient.removeAdjustment(run.hrmsOrgId, run.period, a.externalId);
    run.adjustments.splice(run.adjustments.findIndex((x) => x.externalId === a.externalId), 1);
  }
  if (drop.length) { recalculate(run as unknown as RecalcRun); await run.save(); }

  const staged: Array<{ externalId: string; employeeId: string; kind: "payment" | "deduction"; label: string; amount: number; notes?: string }> = [];
  let unchanged = 0;
  for (const [lineId, w] of wanted) {
    if (!w) continue;
    if (run.adjustments.some((a) => a.source === "crm_slab" && String(a.lineId) === lineId)) { unchanged++; continue; }
    const externalId = makeExternalId(run.runNumber, lineId, nextSeq(run, lineId));
    run.adjustments.push({
      externalId, hrmsEmployeeId: w.line.hrmsEmployeeId, lineId: w.line._id, kind: w.kind, source: "crm_slab", label: w.label, amountMinor: w.amountMinor,
      notes: w.notes, commissionRecordIds: [], crmPayoutIds: [], crm: w.crm,
      recoveredMinor: w.kind === "addition" ? w.amountMinor : 0, outstandingMinor: 0, syncedAt: null, createdById: oid(actor.userId), createdByName: user?.name ?? "",
    } as never);
    staged.push({ externalId, employeeId: w.line.hrmsEmployeeId, kind: w.kind === "addition" ? "payment" : "deduction", label: w.label, amount: w.amountMinor / 100, notes: w.notes });
  }
  let outcomes: HrmsAdjustmentOutcome[] = [];
  if (staged.length) {
    outcomes = (await hrmsClient.applyAdjustments(run.hrmsOrgId, run.period, staged)).outcomes;
    absorbOutcomes(run, outcomes);
    recalculate(run as unknown as RecalcRun);
    await run.save();
  }

  const notes = [
    ...(missed.length ? [`On a CRM salary slab but not put on it here: ${missed.join(", ")}.`] : []),
    ...(root.failures.length ? [`Root couldn't read ${root.failures.map((f) => f.crm).join(", ")} — their people keep what they had; pull again later.`] : []),
  ];
  const level = [...wanted.values()].filter((w) => w === null).length;
  return {
    pulled: staged.length,
    message: [
      staged.length || drop.length || unchanged || level
        ? `${staged.length} put on their salary slab${drop.length ? `, ${drop.length} earlier item${drop.length === 1 ? "" : "s"} taken off` : ""}${unchanged ? `, ${unchanged} as they were` : ""}${level ? `, ${level} already paid their slab` : ""}.`
        : "Nobody on this run is on a CRM salary slab this month.",
      ...notes,
    ].join(" "),
    ...summariseOutcomes(run, outcomes),
  };
}

/**
 * The CS Portal's commission for this run's people (2026-11-03), like the CRMs': every period a manager approved on
 * the CS commission page and nobody has paid — ending this run's month or before — found on the run by the CS's CS
 * Portal email (an employee's email here), in the line's currency. One addition per period, at the approved figure.
 */
async function stageCsCommission(orgId: string, run: PayrollRunDoc, actor: { userId: string }, actorName: string, staged: Staged): Promise<{ note: string; payoutIds: Types.ObjectId[] }> {
  const payouts = await CsCommissionPayout.find({ state: "approved", payrollRunId: null, lastMonth: { $lte: run.period } }).sort({ lastMonth: 1 }).lean<any[]>();
  if (!payouts.length) return { note: "", payoutIds: [] };
  const emails = [...new Set(payouts.map((p) => String(p.email ?? "").toLowerCase()).filter(Boolean))];
  const employees = emails.length ? await Employee.find({
    organizationId: oid(orgId), hrmsOrgId: run.hrmsOrgId, email: { $in: emails }, hrmsEmployeeId: { $in: run.lines.map((l) => l.hrmsEmployeeId) },
  }).lean() : [];
  const employeeOf = new Map(employees.map((e) => [String(e.email).toLowerCase(), e]));
  const payoutIds: Types.ObjectId[] = [];
  const missed: string[] = [];
  for (const p of payouts) {
    const employee = employeeOf.get(String(p.email ?? "").toLowerCase());
    const line = employee ? run.lines.find((l) => l.hrmsEmployeeId === employee.hrmsEmployeeId) : undefined;
    const lineCurrency = (line?.currency || run.currency || "AED").toUpperCase();
    if (!line || lineCurrency !== String(p.currency || "AED").toUpperCase()) {
      missed.push(`${p.personName} (${periodLabel(p.kind, p.period)})`);
      continue;
    }
    if (p.amountMinor <= 0) continue;
    const externalId = makeExternalId(run.runNumber, String(line._id), nextSeq(run, String(line._id)));
    const label = `CS commission — ${periodLabel(p.kind, p.period)}`;
    run.adjustments.push({
      externalId, hrmsEmployeeId: line.hrmsEmployeeId, lineId: line._id, kind: "addition", source: "cs_commission", label, amountMinor: p.amountMinor,
      notes: `Approved by ${p.approvedByName || "a manager"}`.slice(0, 500), commissionRecordIds: [], crmPayoutIds: [], csPayoutIds: [p._id],
      recoveredMinor: p.amountMinor, outstandingMinor: 0, syncedAt: null, createdById: oid(actor.userId), createdByName: actorName,
    } as never);
    staged.push({ externalId, employeeId: line.hrmsEmployeeId, kind: "payment", label, amount: p.amountMinor / 100 });
    payoutIds.push(p._id);
  }
  return {
    note: missed.length ? `Approved CS commission not on this run (no employee here with their CS Portal email, or another currency): ${missed.join(", ")}.` : "",
    payoutIds,
  };
}

export async function removeAdjustment(orgId: string, runId: string, externalId: string) {
  const run = await loadRun(orgId, runId);
  requireAdjustable(run);

  const index = run.adjustments.findIndex((a) => a.externalId === externalId);
  if (index === -1) throw new AppError("NOT_FOUND", "No such adjustment on this run");
  const line = run.lines.find((l) => String(l._id) === String(run.adjustments[index]!.lineId));
  if (line) {
    requireLineAdjustable(run, line);
    const rest = run.adjustments.filter((_, i) => i !== index) as unknown as RecalcAdjustment[];
    requireStillOwed(run, line, line.netFromHrmsMinor + lineAdjustmentTotal(rest, line._id), `taking "${run.adjustments[index]!.label}" off`);
  }

  // HRMS first again: if it refuses, this side is untouched and the two stay in
  // step. Removing here first would leave a payslip carrying money the run no
  // longer knows about.
  await hrmsClient.removeAdjustment(run.hrmsOrgId, run.period, externalId);

  // CRM commission taken off the run is the CRM commission page's to pay again.
  const crmPayouts = run.adjustments[index]!.crmPayoutIds ?? [];
  if (crmPayouts.length) await CrmCommissionPayout.updateMany({ _id: { $in: crmPayouts }, state: "approved" }, { $set: { payrollRunId: null, payrollRunNumber: "" } });
  // CS commission likewise (2026-11-03).
  const csPayouts = run.adjustments[index]!.csPayoutIds ?? [];
  if (csPayouts.length) await CsCommissionPayout.updateMany({ _id: { $in: csPayouts }, state: "approved" }, { $set: { payrollRunId: null, payrollRunNumber: "" } });
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
    // HRMS answers in the payslip's own currency, which need not be the run's.
    const cur = line?.currency || run.currency;
    const asked = toMinor(o.amount);
    const applied = toMinor(o.appliedAmount);
    const movement = toMinor(o.netAfter) - toMinor(o.netBefore);

    if (o.kind === "deduction" && applied < asked) {
      notes.push(
        `${who}: only ${formatMinor(applied, cur)} of the ${formatMinor(asked, cur)} ` +
          `deduction could be recovered this month; ${formatMinor(toMinor(o.outstanding), cur)} carries to next month.`,
      );
    }
    if (o.kind === "payment" && movement !== asked) {
      notes.push(
        `${who}: ${formatMinor(asked, cur)} was added but net pay moved by ` +
          `${formatMinor(movement, cur)} — the difference went to loan or advance recovery that the month can now afford.`,
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
