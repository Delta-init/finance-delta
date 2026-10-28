import { bonusCurrency } from "@delta/shared";
import { Invoice } from "../invoice/invoice.model";
import { LmsProvision } from "./lms-provision.model";
import { lookupCommissionStudents, type CommissionStudentLookup } from "../../lib/commission-client";

/**
 * Where enrolments a sales CRM handed over got to — for its My Enrolments.
 *
 * The invoice: its number, approval, status and money, as always, and what
 * finance flagged on it for accounts to check (`flags`). And, once
 * accounts approved it, what became of the student, from the provisioning
 * record behind the approval:
 *
 *   lms         did the LMS take them — a new account or one they had, on
 *               which courses — or are they waiting, refused, or on a course
 *               no LMS course is linked to;
 *   commission  did they go on to CS Portal, and who looks after them
 *               there: their student code, their CS and the CS team — and, from
 *               CS Portal live, whether they are onboarded (their welcome
 *               went) and where the MT5 bonus promised at this close stands with
 *               the broker admins: "none" when no bonus was promised (nothing to
 *               approve). Asked of CS Portal live, so a student given to
 *               another CS reads as they are now; when it cannot be asked, what
 *               finance was told when it sent them, marked `live: false`, with
 *               onboarding and the bonus left unknown.
 *
 * Those are the steps the sales CRMs show on every enrolment, and count their
 * commission from once all are done.
 *
 * Deliberately narrow still: enough to show somebody where their sale got to,
 * nothing more of the ledger.
 */

export interface EnrolmentLms {
  state: "created" | "existing" | "waiting" | "unmapped" | "failed";
  detail?: string;
  /** The LMS courses they were put on, the invoice's first course first. */
  courses: string[];
}

export interface EnrolmentCommission {
  state: "sent" | "waiting" | "skipped" | "failed" | "not_sent";
  detail?: string;
  code?: string;
  /** Their CS in CS Portal; "" while they wait in Delta Open Students. */
  cs?: string;
  team?: string;
  /** Whether cs and team are CS Portal's answer now (true) or what finance was told when it sent them (false). */
  live?: boolean;
  /** Their welcome went (CS Portal onboarded them); absent when it could not be asked. */
  onboarded?: { done: boolean; at?: string; by?: string };
  /** The MT5 bonus promised at this close and its broker-admin approval; absent until they are in CS Portal. */
  bonus?: EnrolmentBonus;
}

export interface EnrolmentBonus {
  /** none: no bonus promised — nothing to approve. unknown: CS Portal could not say. */
  state: "none" | "not_requested" | "pending" | "approved" | "rejected" | "unknown";
  amount?: number;
  currency?: string;
  /** When it was decided (or raised, while pending), and by whom. */
  at?: string;
  by?: string;
  reason?: string;
}

export interface EnrolmentStatus {
  externalId: string;
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  approval: string;
  returnedReason: string;
  issueDate: string;
  currency: string;
  totalMinor: number;
  amountPaidMinor: number;
  balanceMinor: number;
  /** The course, the next instalment's date (YYYY-MM-DD, "" when nothing is owed), every payment recorded, and the CRM's balance payments with where each stands (2026-10-13). */
  course: string;
  nextDueOn: string;
  payments: { amountMinor: number; paidOn: string; method: string; receiptNumber?: string }[];
  balancePayments: { externalId: string; amountMinor: number; currency: string; method: string; paidOn: string; status: string; reason?: string; decidedAt?: string; decidedBy?: string; receiptNumber?: string }[];
  /**
   * What finance flagged on the invoice, as it stands now — the same flags the
   * handover answered with (an unmapped course, a rep with no account here, an
   * email that belongs to another client), updated by a correction. [] when none.
   */
  flags: string[];
  /** Null until accounts approve it: nothing has been asked of the LMS yet. */
  lms: EnrolmentLms | null;
  commission: EnrolmentCommission | null;
}

type Provision = {
  invoiceId: unknown;
  status?: string;
  studentCreated?: boolean;
  lmsCourseTitle?: string;
  lastError?: string;
  extraCourses?: { status?: string; lmsCourseTitle?: string; slug?: string }[];
  commission?: {
    state?: string; reason?: string; lastError?: string; studentCode?: string; alreadyThere?: boolean; team?: string; mentorName?: string;
  };
};

function lmsOf(p: Provision): EnrolmentLms {
  const courses = [
    ...(p.status === "sent" && p.lmsCourseTitle ? [p.lmsCourseTitle] : []),
    ...(p.extraCourses ?? []).filter((e) => e.status === "sent").map((e) => e.lmsCourseTitle || e.slug || "").filter(Boolean),
  ];
  switch (p.status) {
    case "sent":
      return p.studentCreated === false
        ? { state: "existing", detail: "Already had an LMS account — the course was added to it", courses }
        : { state: "created", courses };
    case "failed":
      return { state: "failed", detail: p.lastError || "The LMS turned it down", courses };
    case "unmapped":
      return { state: "unmapped", detail: "Its course is not linked to an LMS course", courses };
    default:
      return { state: "waiting", detail: p.lastError ? `Not reached yet (${p.lastError}); trying again` : undefined, courses };
  }
}

function commissionOf(p: Provision): EnrolmentCommission {
  const c = p.commission;
  if (!c?.state) {
    // Students go on to CS Portal only once the LMS has them.
    return p.status === "sent" ? { state: "not_sent", detail: "Not sent to CS Portal" } : { state: "waiting", detail: "After the LMS" };
  }
  switch (c.state) {
    case "sent":
      return {
        state: "sent",
        code: c.studentCode || undefined,
        cs: c.mentorName ?? "",
        team: c.team ?? "",
        live: false,
        ...(c.alreadyThere ? { detail: "Already had a CS Portal account" } : {}),
      };
    case "skipped":
      return { state: "skipped", detail: c.reason || "Not a Forex course" };
    case "failed":
      return { state: "failed", detail: c.lastError || "CS Portal turned it down" };
    default:
      return { state: "waiting", detail: c.lastError ? `Not reached yet (${c.lastError}); trying again` : undefined };
  }
}

/**
 * Whether a sales close promised a bonus — and how much — as the CRM said at the close. Its currency:
 * the one recorded, else USD — a close queued before the CRMs said so (bonusCurrency).
 */
export function promisedBonus(i: { enrolment?: unknown; currency?: unknown; external?: unknown }): { given: boolean; amountMinor: number; currency: string } | null {
  const e = i.enrolment as { crm?: string; bonus?: { given?: boolean; amountMinor?: number; currency?: string } } | undefined;
  const b = e?.bonus;
  if (!b || typeof b.given !== "boolean") return null;
  const source = (i.external as { source?: string } | undefined)?.source;
  return { given: b.given, amountMinor: Number(b.amountMinor) || 0, currency: bonusCurrency(e, String(i.currency || "AED"), source) };
}

/**
 * Onboarding and the bonus, from CS Portal's answer — only when it said
 * (a CS Portal from before these were asked says nothing, and nothing is
 * claimed). This invoice's bonus by our invoice id; none to find, and none
 * promised at the close, is "none": nothing for a broker admin to approve.
 */
function onboardingOf(there: CommissionStudentLookup, i: { _id: unknown; enrolment?: unknown; currency?: unknown; external?: unknown }): Pick<EnrolmentCommission, "onboarded" | "bonus"> {
  if (typeof there.onboarded !== "boolean") return {};
  const onboarded = {
    done: there.onboarded,
    ...(there.onboarded_at ? { at: String(there.onboarded_at) } : {}),
    ...(there.onboarded_by ? { by: there.onboarded_by } : {}),
  };
  const mine = (there.bonuses ?? []).find((b) => b.invoice_id === String(i._id));
  const promised = promisedBonus(i);
  let bonus: EnrolmentBonus;
  if (mine) {
    const decided = mine.state === "approved" || mine.state === "rejected";
    bonus = {
      state: mine.state,
      amount: mine.amount,
      currency: mine.currency,
      ...(decided ? { at: mine.decided_at, by: mine.decided_by } : mine.requested_at ? { at: mine.requested_at } : {}),
      ...(mine.reason ? { reason: mine.reason } : {}),
    };
  } else if (!promised || !promised.given || promised.amountMinor <= 0) {
    bonus = { state: "none" };
  } else {
    // Promised here, but CS Portal has no such bonus on record for this invoice.
    bonus = { state: "unknown", amount: promised.amountMinor / 100, currency: promised.currency };
  }
  return { onboarded, bonus };
}

export async function enrolmentStatusesFor(orgId: unknown, source: string, externalIds: string[]): Promise<EnrolmentStatus[]> {
  const invoices = await Invoice.find({
    organizationId: orgId,
    "external.source": source,
    "external.externalId": { $in: externalIds },
  })
    .select("invoiceNumber status approval totalMinor amountPaidMinor balanceMinor currency external issueDate dueDate payments enrolment.bonus enrolment.crm enrolment.course")
    .lean();
  if (!invoices.length) return [];

  const provisions = (await LmsProvision.find({ invoiceId: { $in: invoices.map((i) => i._id) } })
    .select("invoiceId status studentCreated lmsCourseTitle lastError extraCourses commission")
    .lean()) as unknown as Provision[];
  const provisionOf = new Map(provisions.map((p) => [String(p.invoiceId), p]));

  // Who looks after them now, in one call for the page.
  const codes = provisions.filter((p) => p.commission?.state === "sent" && p.commission.studentCode).map((p) => p.commission!.studentCode!);
  const now = await lookupCommissionStudents(codes);
  // The balance payments its salespeople recorded (2026-10-13), each with where it stands.
  const { balancePaymentsFor } = await import("../balance-payment/balance-payment.service");
  const recorded = await balancePaymentsFor(invoices.map((i) => i._id));

  return invoices.map((i) => {
    const ext = i.external as { externalId?: string; flags?: string[] } | undefined;
    const approval = i.approval as { state?: string; returnedReason?: string } | undefined;
    const p = provisionOf.get(String(i._id));
    let commission = p ? commissionOf(p) : null;
    if (commission?.state === "sent" && commission.code && now) {
      const there = now.get(commission.code.toUpperCase());
      commission = there?.found
        ? { ...commission, cs: there.cs, team: there.team, live: true, ...onboardingOf(there, i) }
        : { ...commission, live: true, cs: "", team: "", detail: "No longer in CS Portal" };
    }
    return {
      externalId: ext?.externalId ?? "",
      invoiceId: String(i._id),
      invoiceNumber: (i.invoiceNumber as string) ?? "",
      status: (i.status as string) ?? "",
      // "not_required" for an invoice raised by somebody trusted with the
      // whole ledger, which is not the same as "nobody has looked yet".
      approval: approval?.state ?? "not_required",
      returnedReason: approval?.returnedReason ?? "",
      issueDate: i.issueDate ? new Date(i.issueDate as unknown as string).toISOString().slice(0, 10) : "",
      currency: (i.currency as string) ?? "",
      totalMinor: (i.totalMinor as number) ?? 0,
      amountPaidMinor: (i.amountPaidMinor as number) ?? 0,
      balanceMinor: (i.balanceMinor as number) ?? 0,
      // For the CRM's Balance payments page (2026-10-13): the course, the next
      // instalment's date while something is owed, every payment recorded, and
      // the ones the CRM sent with where each stands.
      course: ((i.enrolment as { course?: string } | undefined)?.course) ?? "",
      nextDueOn: ((i.balanceMinor as number) ?? 0) > 0 && i.dueDate && i.status !== "void" ? new Date(i.dueDate as unknown as string).toISOString().slice(0, 10) : "",
      payments: ((i.payments as any[]) ?? []).map((p) => ({
        amountMinor: p.amountMinor, paidOn: p.paidOn ? new Date(p.paidOn).toISOString().slice(0, 10) : "", method: p.method,
        ...(p.receiptNumber ? { receiptNumber: p.receiptNumber } : {}),
      })),
      balancePayments: recorded.get(String(i._id)) ?? [],
      flags: ext?.flags ?? [],
      lms: p ? lmsOf(p) : null,
      commission,
    };
  });
}
