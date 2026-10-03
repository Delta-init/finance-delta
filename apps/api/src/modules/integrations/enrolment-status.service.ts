import { Invoice } from "../invoice/invoice.model";
import { LmsProvision } from "./lms-provision.model";
import { lookupCommissionStudents } from "../../lib/commission-client";

/**
 * Where enrolments a sales CRM handed over got to — for its My Enrolments.
 *
 * The invoice: its number, approval, status and money, as always. And, once
 * accounts approved it, what became of the student, from the provisioning
 * record behind the approval:
 *
 *   lms         did the LMS take them — a new account or one they had, on
 *               which courses — or are they waiting, refused, or on a course
 *               no LMS course is linked to;
 *   commission  did they go on to Tetra Commission, and who looks after them
 *               there: their student code, their CS and the CS team. Asked of
 *               Tetra Commission live, so a student given to another CS reads
 *               as they are now; when it cannot be asked, what finance was told
 *               when it sent them, marked `live: false`.
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
  /** Their CS in Tetra Commission; "" while they wait in Delta Open Students. */
  cs?: string;
  team?: string;
  /** Whether cs and team are Tetra Commission's answer now (true) or what finance was told when it sent them (false). */
  live?: boolean;
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
    // Students go on to Tetra Commission only once the LMS has them.
    return p.status === "sent" ? { state: "not_sent", detail: "Not sent to Tetra Commission" } : { state: "waiting", detail: "After the LMS" };
  }
  switch (c.state) {
    case "sent":
      return {
        state: "sent",
        code: c.studentCode || undefined,
        cs: c.mentorName ?? "",
        team: c.team ?? "",
        live: false,
        ...(c.alreadyThere ? { detail: "Already had a Tetra Commission account" } : {}),
      };
    case "skipped":
      return { state: "skipped", detail: c.reason || "Not a Forex course" };
    case "failed":
      return { state: "failed", detail: c.lastError || "Tetra Commission turned it down" };
    default:
      return { state: "waiting", detail: c.lastError ? `Not reached yet (${c.lastError}); trying again` : undefined };
  }
}

export async function enrolmentStatusesFor(orgId: unknown, source: string, externalIds: string[]): Promise<EnrolmentStatus[]> {
  const invoices = await Invoice.find({
    organizationId: orgId,
    "external.source": source,
    "external.externalId": { $in: externalIds },
  })
    .select("invoiceNumber status approval totalMinor amountPaidMinor balanceMinor currency external issueDate")
    .lean();
  if (!invoices.length) return [];

  const provisions = (await LmsProvision.find({ invoiceId: { $in: invoices.map((i) => i._id) } })
    .select("invoiceId status studentCreated lmsCourseTitle lastError extraCourses commission")
    .lean()) as unknown as Provision[];
  const provisionOf = new Map(provisions.map((p) => [String(p.invoiceId), p]));

  // Who looks after them now, in one call for the page.
  const codes = provisions.filter((p) => p.commission?.state === "sent" && p.commission.studentCode).map((p) => p.commission!.studentCode!);
  const now = await lookupCommissionStudents(codes);

  return invoices.map((i) => {
    const ext = i.external as { externalId?: string } | undefined;
    const approval = i.approval as { state?: string; returnedReason?: string } | undefined;
    const p = provisionOf.get(String(i._id));
    let commission = p ? commissionOf(p) : null;
    if (commission?.state === "sent" && commission.code && now) {
      const there = now.get(commission.code.toUpperCase());
      commission = there?.found
        ? { ...commission, cs: there.cs, team: there.team, live: true }
        : { ...commission, live: true, cs: "", team: "", detail: "No longer in Tetra Commission" };
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
      lms: p ? lmsOf(p) : null,
      commission,
    };
  });
}
