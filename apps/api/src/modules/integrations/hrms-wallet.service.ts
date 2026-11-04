import { PayrollRun } from "../payroll/payroll-run.model";
import { CrmCommissionPayout } from "../crm-commission/crm-commission-payout.model";
import { CsCommissionPayout } from "../cs-commission/cs-commission-payout.model";
import { fromRoot } from "../crm-commission/crm-commission.service";

/*
 * HRMS's wallet page (the user, 2026-11-04: "a wallet … based on the finance portal, how much is available"). HRMS
 * works out the days and the payslip; this says what only finance knows about one person's month — what payroll owes
 * and has paid them (part payments included, which HRMS is never told about), and where their CRM and CS commission
 * stands. Read-only, and across every finance organization: an HRMS employee id is unique wherever it is paid.
 */

const major = (minor: number | null | undefined) => Math.round(Number(minor) || 0) / 100;
const day = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().slice(0, 10) : null);

export interface HrmsWalletPayment {
  paymentId: string;
  paidOn: string | null;
  method: string;
  account: string;
  reference: string;
  /** This person's share of the payment, not the transfer's total. */
  amount: number;
  reversed: boolean;
  reversalReason: string;
  /** Whether it paid the last of what they were owed. */
  finished: boolean;
}

export interface HrmsWalletPayroll {
  runNumber: string;
  runStatus: string;
  currency: string;
  lineStatus: string;
  holdReason: string;
  /** What finance owes them: HRMS's net plus finance's own additions and deductions. */
  payable: number;
  paid: number;
  balance: number;
  adjustments: Array<{ externalId: string; kind: "addition" | "deduction"; source: string; label: string; amount: number; recovered: number }>;
  payments: HrmsWalletPayment[];
}

export interface HrmsWalletCrm {
  crm: string;
  crmName: string;
  currency: string;
  /** Commission earned in the month, as the CRM counts it. */
  earned: number;
  /** What My Pay pays of it at their slab, null when the CRM couldn't say. */
  payable: number | null;
  percent: number | null;
  level: string | null;
  sales: number;
  /** Earned on sales whose clients are still paying — counted the month the last payment lands. */
  waiting: number;
  state: "earned" | "approved" | "paid";
  /** The figure finance approved (frozen then), once it has. */
  approved: number | null;
  approvedAt: string | null;
  payrollRunNumber: string;
  paidOn: string | null;
  paymentMethod: string;
  reference: string;
}

export interface HrmsWalletCs {
  kind: string;
  period: string;
  currency: string;
  amount: number;
  state: "approved" | "paid";
  approvedAt: string | null;
  payrollRunNumber: string;
  paidOn: string | null;
  paymentMethod: string;
  reference: string;
}

export interface HrmsWallet {
  month: string;
  payroll: HrmsWalletPayroll[];
  crm: HrmsWalletCrm[];
  /** Why the CRMs' commission couldn't be read, when it couldn't. */
  crmError: string | null;
  cs: HrmsWalletCs[];
}

type RunLike = {
  runNumber: string;
  status: string;
  currency?: string | null;
  lines: Array<{ _id: unknown; hrmsEmployeeId: string; currency?: string | null; status?: string | null; holdReason?: string | null; payableMinor: number; amountPaidMinor?: number | null }>;
  adjustments?: Array<{ externalId: string; lineId: unknown; kind: "addition" | "deduction"; source: string; label: string; amountMinor: number; recoveredMinor?: number | null }>;
  payments?: Array<{
    paymentId: string; method: string; paidOn: Date | string; reference?: string | null; bankAccountName?: string | null;
    allocations?: Array<{ lineId: unknown; amountMinor: number }>; finishedLineIds?: unknown[] | null;
    reversedAt?: Date | string | null; reversalReason?: string | null;
  }>;
};

/** One person's line on a run, as the wallet shows it; null when they aren't on it. */
export function payrollLineOf(run: RunLike, hrmsEmployeeId: string): HrmsWalletPayroll | null {
  const line = run.lines.find((l) => l.hrmsEmployeeId === hrmsEmployeeId);
  if (!line) return null;
  const lineId = String(line._id);
  const payable = major(line.payableMinor);
  const paid = major(line.amountPaidMinor);
  return {
    runNumber: run.runNumber,
    runStatus: run.status,
    currency: line.currency || run.currency || "AED",
    lineStatus: line.status ?? "pending",
    holdReason: line.holdReason ?? "",
    payable,
    paid,
    balance: Math.round((payable - paid) * 100) / 100,
    adjustments: (run.adjustments ?? [])
      .filter((a) => String(a.lineId) === lineId)
      .map((a) => ({
        externalId: a.externalId, kind: a.kind, source: a.source, label: a.label,
        amount: major(a.amountMinor), recovered: major(a.recoveredMinor ?? (a.kind === "addition" ? a.amountMinor : 0)),
      })),
    payments: (run.payments ?? []).flatMap((p) => {
      const share = (p.allocations ?? []).find((a) => String(a.lineId) === lineId);
      if (!share) return [];
      return [{
        paymentId: p.paymentId,
        paidOn: day(p.paidOn),
        method: p.method,
        account: p.bankAccountName ?? "",
        reference: p.reference ?? "",
        amount: major(share.amountMinor),
        reversed: !!p.reversedAt,
        reversalReason: p.reversalReason ?? "",
        // Payments from before part pay (2026-11-03) carry no list: each paid everybody in it in full.
        finished: p.finishedLineIds ? p.finishedLineIds.some((id) => String(id) === lineId) : true,
      }];
    }).sort((a, b) => String(a.paidOn).localeCompare(String(b.paidOn))),
  };
}

/**
 * Root's month of CRM commission, kept a few minutes: a wallet opened by everybody on payday would otherwise ask every
 * CRM for the whole month once per person.
 */
const ROOT_TTL_MS = 3 * 60 * 1000;
const rootMonths = new Map<string, { at: number; crms: Awaited<ReturnType<typeof fromRoot>> }>();
async function rootMonth(month: string) {
  const hit = rootMonths.get(month);
  if (hit && Date.now() - hit.at < ROOT_TTL_MS) return hit.crms;
  const crms = await fromRoot(month);
  rootMonths.set(month, { at: Date.now(), crms });
  return crms;
}

async function crmCommission(emails: string[], month: string): Promise<{ rows: HrmsWalletCrm[]; error: string | null }> {
  if (!emails.length) return { rows: [], error: null };
  let crms: Awaited<ReturnType<typeof fromRoot>>;
  try {
    crms = await rootMonth(month);
  } catch (err) {
    return { rows: [], error: (err as Error).message };
  }
  const mine = crms.flatMap((c) => (c.people ?? [])
    .filter((p) => p.email && emails.includes(p.email.trim().toLowerCase()))
    .map((p) => ({ c, p, key: `${c.code}:${month}:${p.userId}` })));
  const payouts = mine.length
    ? await CrmCommissionPayout.find({ key: { $in: mine.map((m) => m.key) } }).lean<any[]>()
    : [];
  const payoutOf = new Map(payouts.map((p) => [String(p.key), p]));
  const rows = mine.map(({ c, p, key }): HrmsWalletCrm => {
    const payout = payoutOf.get(key);
    return {
      crm: c.code,
      crmName: c.name,
      currency: payout?.currency ?? c.currency ?? "AED",
      earned: Number(p.amount) || 0,
      payable: p.payable ?? null,
      percent: p.percent ?? null,
      level: p.level ?? null,
      sales: Number(p.sales) || 0,
      waiting: Number(p.waiting) || 0,
      state: payout?.state ?? "earned",
      approved: payout ? major(payout.amountMinor) : null,
      approvedAt: payout ? day(payout.approvedAt) : null,
      payrollRunNumber: payout?.payrollRunNumber ?? "",
      paidOn: day(payout?.paidOn ?? null),
      paymentMethod: payout?.paymentMethod ?? "",
      reference: payout?.reference ?? "",
    };
  });
  // Nothing earned and nothing approved is not worth a row.
  return { rows: rows.filter((r) => r.earned > 0 || r.waiting > 0 || r.approved !== null), error: null };
}

async function csCommission(emails: string[], month: string): Promise<HrmsWalletCs[]> {
  if (!emails.length) return [];
  const payouts = await CsCommissionPayout.find({ email: { $in: emails }, lastMonth: month }).sort({ kind: 1 }).lean<any[]>();
  return payouts.map((p) => ({
    kind: p.kind,
    period: p.period,
    currency: p.currency ?? "AED",
    amount: major(p.amountMinor),
    state: p.state,
    approvedAt: day(p.approvedAt),
    payrollRunNumber: p.payrollRunNumber ?? "",
    paidOn: day(p.paidOn ?? null),
    paymentMethod: p.paymentMethod ?? "",
    reference: p.reference ?? "",
  }));
}

/** Everything finance knows about one HRMS employee's month (POST /integrations/hrms/wallet). */
export async function walletForHrms(input: { employeeId: string; emails: string[]; month: string }): Promise<HrmsWallet> {
  const [runs, crm, cs] = await Promise.all([
    PayrollRun.find({ period: input.month, status: { $nin: ["voided", "returned"] }, "lines.hrmsEmployeeId": input.employeeId })
      .select("runNumber status currency lines adjustments payments")
      .lean<RunLike[]>(),
    crmCommission(input.emails, input.month),
    csCommission(input.emails, input.month),
  ]);
  return {
    month: input.month,
    payroll: runs.map((r) => payrollLineOf(r, input.employeeId)).filter((p): p is HrmsWalletPayroll => !!p),
    crm: crm.rows,
    crmError: crm.error,
    cs,
  };
}
