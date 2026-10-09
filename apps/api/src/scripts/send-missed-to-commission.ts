/**
 * Students the LMS took before Tetra Commission was switched on.
 *
 * A student goes on to Tetra Commission at the moment the LMS takes them, and
 * nowhere else (jobs/lms-provision.worker.ts drainLmsProvisions). One the LMS
 * took while COMMISSION_API_URL / COMMISSION_S2S_SECRET were unset — or before
 * the step existed — has no commission state at all, and nothing ever comes
 * back for them: the approvals screen says "Not sent to Tetra Commission" for
 * ever (the user, 2026-10-09, e.g. IN-00086).
 *
 * This lists them, and with --apply marks each one "pending", exactly as the
 * worker would have: its next run sends them, Tetra Commission gives each to the
 * next team in turn, and the approvals screen follows. Only rows the worker
 * itself would have sent — a source that goes to Tetra Commission, never a
 * Banglore CRM student, and a Forex course.
 *
 * Forex is known for a row the LMS named the programme on (lmsCourseProgram).
 * Older rows have no programme kept: they are listed by course, and sent only
 * for the LMS course titles named with --forex-course — never guessed, because
 * a non-Forex student given a CS is a mistake somebody has to undo by hand.
 *
 * READ THIS BEFORE --apply. Each student sent is given to a team and a CS in
 * Tetra Commission, and their CS is told. Run it without --apply first, read
 * the list, and cut it down with --invoice or --since.
 *
 * Run it from apps/api (Bun reads the .env there):
 *
 *   cd apps/api
 *   bun src/scripts/send-missed-to-commission.ts
 *   bun src/scripts/send-missed-to-commission.ts --invoice IN-00086 --apply
 *   bun src/scripts/send-missed-to-commission.ts --since 2026-09-01 --forex-course "MENTOR'S MASTERY COURSE" --apply
 */

import mongoose from "mongoose";
import { NO_COMMISSION_CRMS } from "@delta/shared";
import { connectDb } from "../config/db";
import { LmsProvision } from "../modules/integrations/lms-provision.model";
import { commissionConfigured } from "../lib/commission-client";

const APPLY = process.argv.includes("--apply");
const many = (flag: string) => process.argv.reduce<string[]>((acc, a, i) => (a === flag && process.argv[i + 1] ? [...acc, process.argv[i + 1]!.trim()] : acc), []);
const INVOICES = new Set(many("--invoice").map((s) => s.toUpperCase()));
const FOREX_COURSES = new Set(many("--forex-course").map((s) => s.toLowerCase()));
const sinceArg = process.argv[process.argv.indexOf("--since") + 1];
const SINCE = process.argv.includes("--since") && sinceArg ? new Date(sinceArg) : null;

/* As the worker decides (jobs/lms-provision.worker.ts): whose students go, and what Forex is in the LMS. */
const COMMISSION_SOURCES = new Set(["crm", "draw-crm"]);
const FOREX_PROGRAMME = "4x-trading";

type Row = {
  _id: unknown; invoiceNumber?: string; source?: string; sentAt?: Date; createdAt?: Date;
  lmsCourseTitle?: string; lmsCourseProgram?: string; payload?: { crm?: string; name?: string; email?: string };
};

async function run() {
  if (SINCE && Number.isNaN(SINCE.getTime())) {
    console.error(`--since "${sinceArg}" is not a date. Use YYYY-MM-DD.`);
    process.exit(1);
  }
  await connectDb();
  // Said first: marked rows wait for the worker, and an unconfigured one never sends them.
  console.log(`Tetra Commission link: ${commissionConfigured() ? "configured" : "NOT CONFIGURED — set COMMISSION_API_URL and COMMISSION_S2S_SECRET, or nothing marked here is ever sent"}`);

  const query: Record<string, unknown> = {
    status: "sent",
    $or: [{ commission: { $exists: false } }, { "commission.state": { $exists: false } }, { "commission.state": null }],
    "payload.crm": { $nin: [...NO_COMMISSION_CRMS] },
  };
  if (SINCE) query.sentAt = { $gte: SINCE };
  const rows = (await LmsProvision.find(query)
    .select("_id invoiceNumber source sentAt createdAt lmsCourseTitle lmsCourseProgram payload.crm payload.name payload.email")
    .sort({ sentAt: 1 })
    .lean()) as unknown as Row[];

  const inScope = rows
    .filter((r) => COMMISSION_SOURCES.has(String(r.source ?? "crm")))
    .filter((r) => !INVOICES.size || INVOICES.has(String(r.invoiceNumber ?? "").toUpperCase()));
  const forex = (r: Row) => r.lmsCourseProgram === FOREX_PROGRAMME
    || (!r.lmsCourseProgram && FOREX_COURSES.has(String(r.lmsCourseTitle ?? "").toLowerCase()));
  const toSend = inScope.filter(forex);
  const notForex = inScope.filter((r) => r.lmsCourseProgram && r.lmsCourseProgram !== FOREX_PROGRAMME);
  const unknown = inScope.filter((r) => !r.lmsCourseProgram && !forex(r));

  const line = (r: Row) => `  ${String(r.invoiceNumber || "—").padEnd(10)} ${String(r.payload?.name ?? "").padEnd(28).slice(0, 28)} ${String(r.payload?.email ?? "").padEnd(32).slice(0, 32)} ${String(r.lmsCourseTitle ?? "").slice(0, 40)}  (LMS ${r.sentAt ? r.sentAt.toISOString().slice(0, 10) : "?"})`;
  console.log(`\nIn the LMS, never sent to Tetra Commission${SINCE ? ` (since ${sinceArg})` : ""}${INVOICES.size ? ` (invoices ${[...INVOICES].join(", ")})` : ""}: ${inScope.length}`);
  console.log(`\nForex — ${APPLY ? "marked to send" : "would be sent"}: ${toSend.length}`);
  toSend.forEach((r) => console.log(line(r)));
  if (notForex.length) {
    console.log(`\nNot Forex — never sent: ${notForex.length}`);
    notForex.forEach((r) => console.log(`${line(r)}  [${r.lmsCourseProgram}]`));
  }
  if (unknown.length) {
    const byCourse = new Map<string, number>();
    for (const r of unknown) byCourse.set(String(r.lmsCourseTitle ?? "(no course title)"), (byCourse.get(String(r.lmsCourseTitle ?? "(no course title)")) ?? 0) + 1);
    console.log(`\nProgramme not kept (older rows) — left alone unless their course is named with --forex-course: ${unknown.length}`);
    [...byCourse].sort((a, b) => b[1] - a[1]).forEach(([course, n]) => console.log(`  ${String(n).padStart(4)}  ${course}`));
    unknown.forEach((r) => console.log(line(r)));
  }

  if (!APPLY) {
    console.log(`\nNothing changed. Add --apply to mark the ${toSend.length} Forex student(s) above; the worker sends them within a minute.`);
    return;
  }
  let marked = 0;
  for (const r of toSend) {
    // Only if still untouched: a row the worker reached meanwhile is left as it is.
    const res = await LmsProvision.updateOne(
      { _id: r._id, status: "sent", $or: [{ "commission.state": { $exists: false } }, { "commission.state": null }], "payload.crm": { $nin: [...NO_COMMISSION_CRMS] } },
      { $set: { "commission.state": "pending", "commission.course": r.lmsCourseTitle ?? "", "commission.attempts": 0, "commission.nextAttemptAt": new Date() } },
    );
    marked += res.modifiedCount;
  }
  console.log(`\nMarked ${marked} to send. The worker sends them on its next run — watch the approvals screen move to "Sent".`);
}

run()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
