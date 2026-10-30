import { Types } from "mongoose";
import { AppError } from "../../lib/http";
import { hrmsClient, type HrmsBatch } from "../../lib/hrms-client";
import { nextNumber } from "../sequence/sequence.service";
import { Employee } from "../employee/employee.model";
import { PayrollOrgLink } from "../payroll-mapping/org-link.model";
import { User } from "../user/user.model";
import { PayrollRun } from "./payroll-run.model";
import { toMinor, formatMinor, assertTotalsAgree } from "./money";
import {
  batchByCurrency, currencyOf, summariseByCurrency, type BatchCurrencyTotals,
} from "./currency-totals";

// Lives in currency-totals, so it can be tested without config; still offered here.
export { summariseByCurrency };

const oid = (id: string) => new Types.ObjectId(id);

/** "AED 344,824.88 + INR 627,633.33": one amount per currency, never their sum. */
function formatByCurrency(rows: Array<{ currency: string; minor: number }>): string {
  return rows.map((r) => formatMinor(r.minor, r.currency)).join(" + ");
}

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
  /**
   * Every payslip added together, as HRMS adds them to check its lines. An
   * amount of money only when everybody is paid in one currency; show
   * `byCurrency` instead.
   */
  totals: { employeeCount: number; grossMinor: number; deductionsMinor: number; netMinor: number };
  /** The month per currency people are paid in, the batch's own first. */
  byCurrency: BatchCurrencyTotals[];
  /** On this payroll but not yet mapped in finance. A sync fixes these. */
  unmapped: Array<{ hrmsEmployeeId: string; employeeCode: string; name: string }>;
  /** Payslips whose employee record no longer exists in HRMS. A sync cannot. */
  orphaned: Array<{ hrmsEmployeeId: string; employeeCode: string; name: string }>;
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

/**
 * A month's payslips per currency. Empty when HRMS sent an amount that is not a
 * number; `convert` reports that as a blocker.
 */
function batchCurrencies(batch: HrmsBatch): BatchCurrencyTotals[] {
  try {
    return batchByCurrency(
      batch.lines.map((l) => ({
        currency: l.currency,
        grossMinor: toMinor(l.grossPay),
        deductionsMinor: toMinor(l.totalDeductions),
        netMinor: toMinor(l.netPay),
      })),
      batch.currency,
    );
  } catch {
    return [];
  }
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
  const missing = batch.lines
    .filter((l) => !known.has(l.employeeId))
    .map((l) => ({
      hrmsEmployeeId: l.employeeId,
      employeeCode: l.employeeCode,
      name: l.name,
      // The flag when HRMS sends it; otherwise inferred. A line with neither a
      // code nor a name is one HRMS could not resolve to an employee — it
      // builds both from the employee record and falls back to empty strings.
      // Inferring it here means this works against an HRMS that predates the
      // flag, rather than waiting on a deploy to stop giving wrong advice.
      employeeMissing: l.employeeMissing === true || (!l.employeeCode && !l.name),
    }));

  // Two different problems that used to read as one.
  //
  // Somebody not yet mapped is fixed by running a sync. Somebody whose HRMS
  // record has been deleted cannot be — there is nobody left to map, and a
  // payslip is all that remains of them. Telling accounts to run a sync in
  // that case sends them round a loop that cannot terminate, which is what
  // happened here: two deleted employees left payslips behind, and the import
  // was blocked with the only suggested remedy being one that does nothing.
  const unmapped = missing.filter((m) => !m.employeeMissing);
  const orphaned = missing.filter((m) => m.employeeMissing);

  if (unmapped.length) {
    blockers.push(
      `${unmapped.length} person(s) on this payroll are not mapped in finance. Run a mapping sync first.`,
    );
  }
  if (orphaned.length) {
    blockers.push(
      `${orphaned.length} payslip(s) belong to employees who have been deleted in HRMS. ` +
        `A mapping sync cannot fix this — HR needs to remove those payslips or restore the employee records.`,
    );
  }

  const unpayable = batch.lines.filter((l) => !l.payable).map((l) => ({ employeeCode: l.employeeCode, name: l.name }));
  if (unpayable.length) {
    // A warning, not a blocker: the rest of the run can still be paid, and
    // holding fifty-nine people for one missing IBAN is the worse outcome.
    warnings.push(`${unpayable.length} person(s) have no bank details and will be held.`);
  }

  const existing = await PayrollRun.findOne({ organizationId: oid(orgId), hrmsOrgId, period }).lean();
  if (existing && existing.status !== "returned") {
    blockers.push(`This month has already been imported as ${existing.runNumber}.`);
  }
  if (existing && existing.status === "returned") {
    // Sending a month back is an instruction to HR to change it, so the point
    // of doing so is to import it again afterwards. Treating the returned run
    // as "already imported" blocked exactly the thing it was sent back for,
    // and left accounts looking at the figures they had rejected.
    //
    // The run is refreshed rather than duplicated: same number, same month,
    // new figures. HRMS is the source, and any adjustment written through to
    // a payslip is already in the numbers coming back — so the lines are
    // replaced wholesale rather than merged, which is also what stops an
    // adjustment being counted twice.
    warnings.push(
      `${existing.runNumber} was sent back to HR and will be refreshed with what HRMS has now. ` +
        `Anything accounts added last time is already on the HRMS payslips and comes back in these figures.`,
    );
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
    byCurrency: batchCurrencies(batch),
    unmapped,
    orphaned,
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

  // A month sent back to HR keeps its run when it comes again: same number,
  // same record, new figures. A second run for the same month would leave two
  // records claiming the same payroll, and nothing to say which one was paid.
  const returned = await PayrollRun.findOne({
    organizationId: oid(orgId),
    hrmsOrgId,
    period,
    status: "returned",
  });

  const runNumber =
    returned?.runNumber ??
    (await nextNumber(orgId, "payroll_run", `PAY-${period.replace("-", "")}-`, 3));
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
      // The payslip's own currency, which need not be the batch's.
      currency: source.currency || batch.currency,
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

  const figures = {
    currency: batch.currency,
    status: "imported" as const,
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
  };

  let run;
  if (returned) {
    // Every figure replaced, including the lines. The reason it was sent back
    // goes too — it has been acted on, and leaving it would read as a standing
    // complaint about numbers that have since changed.
    returned.set({ ...figures, returnedReason: "" });
    await returned.save();
    run = returned;
  } else {
    run = await PayrollRun.create({
      organizationId: oid(orgId),
      hrmsOrgId,
      hrmsOrgName: link.hrmsOrgName,
      runNumber,
      period,
      ...figures,
    });
  }

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

  const byCurrency = batchByCurrency(
    docLines.map((l) => ({
      currency: l.currency, grossMinor: l.grossMinor, deductionsMinor: l.deductionsMinor, netMinor: l.netFromHrmsMinor,
    })),
    batch.currency,
  );

  return {
    id: String(run._id),
    runNumber,
    period,
    currency: batch.currency,
    employeeCount: docLines.length,
    /** Every payslip added together; see `byCurrency` for amounts of money. */
    netMinor: sum.net,
    byCurrency,
    netFormatted: formatByCurrency(byCurrency.map((r) => ({ currency: r.currency, minor: r.netMinor }))),
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
      // Of each line only what its currency's totals need, not the payslip itself.
      .select(
        "runNumber period hrmsOrgName currency status payableMinor amountPaidMinor balanceMinor importedAt importedByName " +
          "lines.currency lines.grossMinor lines.deductionsMinor lines.payableMinor lines.amountPaidMinor",
      )
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
      /** The three figures above per currency. More than one row means those add unlike things. */
      byCurrency: summariseByCurrency(r.lines ?? [], r.currency),
      importedAt: r.importedAt ? (r.importedAt as Date).toISOString() : null,
      importedByName: r.importedByName,
    })),
    meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
  };
}

export async function getRun(orgId: string, id: string) {
  const run = await PayrollRun.findOne({ _id: oid(id), organizationId: oid(orgId) }).lean();
  if (!run) throw new AppError("NOT_FOUND", "Payroll run not found");
  const lineCurrency = new Map(run.lines.map((l) => [String(l._id), currencyOf(l.currency, run.currency)]));

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
    /**
     * The same totals split by what each person is actually paid in.
     *
     * The single figures above add every line together, which is only a real
     * number when everybody shares a currency. They often do not — a month can
     * carry salaries in dirhams and salaries in rupees, and adding those gives
     * a total that is not an amount of anything.
     *
     * One entry means the run is single-currency and the figures above are
     * sound. More than one means they are not, and the interface says so
     * rather than presenting a sum of unlike things.
     */
    byCurrency: summariseByCurrency(run.lines, run.currency),
    lines: run.lines.map((l) => ({
      id: String(l._id),
      hrmsEmployeeId: l.hrmsEmployeeId,
      employeeId: l.employeeId ? String(l.employeeId) : null,
      employeeCode: l.employeeCode,
      name: l.name,
      designation: l.designation,
      departmentName: l.departmentName,
      // Falls back to the run's for lines imported before this was carried.
      currency: l.currency || run.currency,
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
    adjustments: run.adjustments.map((a) => ({
      externalId: a.externalId,
      hrmsEmployeeId: a.hrmsEmployeeId,
      lineId: String(a.lineId),
      // The person's, since it lands on their payslip: a rupee salary's addition is rupees.
      currency: lineCurrency.get(String(a.lineId)) ?? run.currency,
      kind: a.kind,
      source: a.source,
      label: a.label,
      amountMinor: a.amountMinor,
      notes: a.notes,
      recoveredMinor: a.recoveredMinor,
      outstandingMinor: a.outstandingMinor,
      syncedAt: a.syncedAt ? (a.syncedAt as Date).toISOString() : null,
      createdByName: a.createdByName,
    })),
    payments: run.payments.map((p) => ({
      paymentId: p.paymentId,
      method: p.method,
      paidOn: (p.paidOn as Date).toISOString(),
      reference: p.reference,
      bankAccountName: p.bankAccountName,
      // Its account's; the run's for a payment recorded before a payment carried one.
      currency: p.currency || run.currency,
      amountMinor: p.amountMinor,
      payslipCount: p.allocations.length,
      // Surfaced, never hidden: money moved but HRMS was not told is the one
      // state where the two systems disagree about whether somebody was paid.
      syncedToHrms: p.syncedToHrms,
      syncError: p.syncError,
      // Kept so the screen can stop offering to reverse something already
      // reversed, rather than letting the API refuse it after the click.
      reversedAt: p.reversedAt ? (p.reversedAt as Date).toISOString() : null,
      reversalReason: p.reversalReason,
      createdByName: p.createdByName,
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
    /** The month's net per currency, the batch's own first. Empty when it could not be worked out. */
    byCurrency: Array<{ currency: string; employeeCount: number; netMinor: number }>;
    /** The state of the run that owns this month, when there is one. */
    runStatus: string | null;
  }> = [];

  for (const link of links) {
    const batches = await hrmsClient.payrollBatches(link.hrmsOrgId).catch(() => []);
    const runs = await PayrollRun.find({ organizationId: oid(orgId), hrmsOrgId: link.hrmsOrgId })
      .select("period runNumber status")
      .lean();
    const runByPeriod = new Map(runs.map((r) => [r.period, r]));

    for (const b of batches) {
      // "Imported" means accounts hold this month, not merely that a run
      // record exists. A returned run has handed it back to HR, so the month
      // is waiting to come again — and the screen that lists what is waiting
      // filters on this flag, so treating a returned run as imported hid the
      // month for good and left no way to re-import it.
      const imported = Boolean(
        runByPeriod.get(b.month) && runByPeriod.get(b.month)!.status !== "returned",
      );

      let byCurrency: Array<{ currency: string; employeeCount: number; netMinor: number }> = [];
      try {
        byCurrency = (b.byCurrency ?? [])
          .filter((r) => r.employeeCount > 0)
          .map((r) => ({ currency: currencyOf(r.currency, b.currency), employeeCount: r.employeeCount, netMinor: toMinor(r.netTotal) }));
      } catch {
        byCurrency = []; // An amount that is not a number: worked out from the payslips below instead.
      }
      // A month HR submitted before HRMS split its totals carries one figure
      // that adds rupees to dirhams, and no breakdown: only its payslips can
      // say what it is. Asked for just the months waiting here, the only ones
      // shown with an amount. If HRMS cannot answer, no amount rather than the
      // wrong one.
      if (!byCurrency.length && !imported && b.status === "submitted") {
        byCurrency = await hrmsClient
          .payrollBatch(link.hrmsOrgId, b.month)
          .then((full) => batchCurrencies(full).map(({ currency, employeeCount, netMinor }) => ({ currency, employeeCount, netMinor })))
          .catch(() => []);
      }

      out.push({
        hrmsOrgId: link.hrmsOrgId,
        hrmsOrgName: link.hrmsOrgName,
        period: b.month,
        status: b.status,
        currency: b.currency,
        // Everybody, whatever they are paid in. HRMS's own count is the batch
        // currency's people alone once it splits its totals.
        employeeCount: byCurrency.length ? byCurrency.reduce((a, r) => a + r.employeeCount, 0) : b.employeeCount,
        netTotal: b.netTotal,
        byCurrency,
        imported,
        runNumber: runByPeriod.get(b.month)?.runNumber ?? null,
        runStatus: runByPeriod.get(b.month)?.status ?? null,
      });
    }
  }
  return out.sort((a, b) => b.period.localeCompare(a.period));
}

/**
 * Everything about payroll that somebody needs to go and look at.
 *
 * The reason this exists as its own view rather than as a badge on a list: the
 * states it reports are the ones nothing else would surface. A payment that
 * moved money but never reached HRMS looks completely normal from either system
 * on its own — finance shows a paid run, HR shows issued payslips, and only
 * comparing them reveals the problem. Left to be noticed, it is noticed by an
 * employee asking why their payslip says unpaid.
 */
export async function reconciliation(orgId: string) {
  const runs = await PayrollRun.find({
    organizationId: oid(orgId),
    status: { $nin: ["voided"] },
  })
    .sort({ period: -1 })
    .limit(24)
    .lean();

  const unsyncedPayments: Array<{
    runId: string; runNumber: string; period: string; paymentId: string;
    amountMinor: number; currency: string; paidOn: string; error: string; attempts: number;
  }> = [];
  const heldPeople: Array<{
    runId: string; runNumber: string; period: string; currency: string;
    name: string; employeeCode: string; reason: string; payableMinor: number;
  }> = [];
  const unfinished: Array<{
    runId: string; runNumber: string; period: string; currency: string;
    /** Every currency added together; `outstandingByCurrency` is the amount owed. */
    status: string; outstandingMinor: number; peopleLeft: number;
    outstandingByCurrency: Array<{ currency: string; outstandingMinor: number }>;
  }> = [];

  for (const run of runs) {
    for (const p of run.payments) {
      if (!p.syncedToHrms && !p.reversedAt) {
        unsyncedPayments.push({
          runId: String(run._id), runNumber: run.runNumber, period: run.period,
          paymentId: p.paymentId, amountMinor: p.amountMinor, currency: p.currency || run.currency,
          paidOn: (p.paidOn as Date).toISOString(),
          error: p.syncError || "Never acknowledged", attempts: p.syncAttempts,
        });
      }
    }
    for (const l of run.lines) {
      if (l.status === "on_hold") {
        heldPeople.push({
          runId: String(run._id), runNumber: run.runNumber, period: run.period, currency: currencyOf(l.currency, run.currency),
          name: l.name, employeeCode: l.employeeCode,
          reason: l.holdReason || "No bank details", payableMinor: l.payableMinor,
        });
      }
    }
    const left = run.lines.filter((l) => l.status !== "paid" && l.status !== "on_hold").length;
    if (left > 0 && (run.status === "approved" || run.status === "partially_paid")) {
      unfinished.push({
        runId: String(run._id), runNumber: run.runNumber, period: run.period, currency: run.currency,
        status: run.status, outstandingMinor: run.balanceMinor, peopleLeft: left,
        outstandingByCurrency: summariseByCurrency(run.lines, run.currency)
          .filter((r) => r.balanceMinor !== 0)
          .map((r) => ({ currency: r.currency, outstandingMinor: r.balanceMinor })),
      });
    }
  }

  return {
    unsyncedPayments,
    heldPeople,
    unfinished,
    // A single number the payroll page can badge, so somebody sees it without
    // having to open this screen first.
    total: unsyncedPayments.length + heldPeople.length + unfinished.length,
  };
}
