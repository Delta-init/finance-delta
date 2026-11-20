/**
 * DUBAI-STUD (the user, 2026-11-20): a close from the Sales CRM, Draw or Remote that picked the Bangalore academy is
 * tagged here and told to the LMS and CS Portal as a Dubai student. Against a scratch database, with a stand-in LMS
 * and a stand-in CS Portal that keep what they are sent:
 *
 *   1. backfill:dubai-stud — the dry run finds exactly those (not the Banglore CRM's, not a Dubai close, not a voided
 *      or moved one), changes nothing, and prints the LMS and CS Portal commands filled in; a number named that isn't
 *      one stops it; --apply tags each invoice and its client with one DUBAI-STUD tag; run again, nothing more.
 *   2. The worker: a tagged enrolment goes to the LMS with dubaiStudent (its academy still Bangalore), and its further
 *      courses too; to CS Portal with dubaiStudent; an untagged one without. The tag taken off: sent without.
 *   3. Approvals: a tagged enrolment's row says so; an untagged one's doesn't.
 *
 * Run through scripts/dubai-stud-e2e.sh (a throwaway mongod; nothing reads a .env).
 */
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/finance-[a-z-]*e2e$/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
let pass = 0, fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

/* Stand-ins that keep what they are sent. */
const lmsSent: Array<Record<string, unknown>> = [];
const csSent: Array<Record<string, unknown>> = [];
const stand = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (path === "/api/v1/integrations/finance/enrolment") {
      lmsSent.push(body);
      return Response.json({ success: true, data: {
        userId: new mongoose.Types.ObjectId().toString(), created: true, alreadyProcessed: false,
        courseSlug: body.courseSlug, courseTitle: "MARKET BREAK-OUT TRADING PROGRAM", courseProgram: "4x-trading", organizationSlug: null,
      } });
    }
    if (path === "/api/v1/integrations/finance/students") {
      csSent.push(body);
      return Response.json({ data: {
        created: true, existing: null, studentId: new mongoose.Types.ObjectId().toString(), studentCode: `STU-9${csSent.length}`,
        assignment: "assigned", mentorName: "Chief", teamName: "Dubai Team", detail: "made",
      } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  },
});
process.env.LMS_API_URL = `http://127.0.0.1:${stand.port}`;
process.env.LMS_S2S_SECRET = "e2e-finance-to-lms-secret-long-enough";
process.env.COMMISSION_API_URL = `http://127.0.0.1:${stand.port}`;
process.env.COMMISSION_S2S_SECRET = "e2e-finance-to-cs-portal-secret-long-enough";

await mongoose.connect(uri);
const db = mongoose.connection.db!;
for (const c of await db.listCollections().toArray()) await db.collection(c.name).deleteMany({});
const { Types } = mongoose;

const hq = { _id: new Types.ObjectId(), name: "Delta HQ E2E", createdAt: new Date() };
const blr = { _id: new Types.ObjectId(), name: "Delta Banglore E2E", createdAt: new Date() };
await db.collection("organizations").insertMany([hq, blr]);

let seq = 0;
type Opts = { crm: string; academy: string; state?: string; status?: string; movedTo?: boolean; source?: string };
async function enrolment(org: typeof hq, invoiceNumber: string, o: Opts) {
  const customerId = new Types.ObjectId();
  const email = `client${++seq}@e2e-dubai-stud.test`;
  await db.collection("customers").insertOne({ _id: customerId, organizationId: org._id, customerCode: `CUST-${seq}`, name: `Client ${seq}`, email, tagIds: [], createdAt: new Date() });
  const invoiceId = new Types.ObjectId();
  await db.collection("invoices").insertOne({
    _id: invoiceId, organizationId: org._id, invoiceNumber, customerId, customerName: `Client ${seq}`, currency: "INR", status: o.status ?? "sent",
    totalMinor: 2_500_000, amountPaidMinor: 2_500_000, balanceMinor: 0, tagIds: [],
    approval: { state: o.state ?? "approved", at: new Date(), submittedAt: new Date() },
    external: { source: o.source ?? "crm", externalId: new Types.ObjectId().toString() },
    enrolment: { course: "MBT", crm: o.crm, academy: o.academy, ...(o.movedTo ? { movedTo: { invoiceId: new Types.ObjectId(), invoiceNumber: "IN-1", academy: "dubai" } } : {}) },
    createdAt: new Date(),
  });
  return { invoiceId, customerId, email };
}
const sales = await enrolment(blr, "IN-00050", { crm: "delta", academy: "bangalore" });
const remote = await enrolment(blr, "IN-00028", { crm: "remote", academy: "bangalore" });
const waiting = await enrolment(blr, "IN-00053", { crm: "remote", academy: "bangalore", state: "pending", status: "draft" });
const draw = await enrolment(blr, "IN-00060", { crm: "", academy: "bangalore", source: "draw-crm" });
const banglore = await enrolment(blr, "IN-00036", { crm: "banglore", academy: "bangalore" });
const dubai = await enrolment(hq, "IN-00500", { crm: "delta", academy: "dubai" });
const voided = await enrolment(blr, "IN-00061", { crm: "draw", academy: "bangalore", status: "void" });
const moved = await enrolment(blr, "IN-00062", { crm: "delta", academy: "bangalore", movedTo: true });

// Already in the LMS and CS Portal (the Sales one); in the LMS only, not Forex (the Remote one).
await db.collection("lmsprovisions").insertMany([
  { organizationId: blr._id, invoiceId: sales.invoiceId, invoiceNumber: "IN-00050", source: "crm", status: "sent", payload: { email: sales.email, courseSlug: "mbt" }, lmsUserId: "u1", commission: { state: "sent", studentCode: "STU-0001" }, createdAt: new Date() },
  { organizationId: blr._id, invoiceId: remote.invoiceId, invoiceNumber: "IN-00028", source: "crm", status: "sent", payload: { email: remote.email, courseSlug: "ai" }, lmsUserId: "u2", commission: { state: "skipped" }, createdAt: new Date() },
]);

async function run(...args: string[]) {
  const p = Bun.spawn(["bun", "--no-env-file", "src/scripts/backfill-dubai-stud.ts", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}
const tagDocs = () => db.collection("tags").find({ name: /^dubai-stud$/i }).toArray();
const tagged = async (id: unknown, coll = "invoices") => {
  const [t] = await tagDocs();
  const doc = (await db.collection(coll).findOne({ _id: id as never })) as { tagIds?: unknown[] } | null;
  return !!t && (doc?.tagIds ?? []).some((x) => String(x) === String(t._id));
};

step("1. backfill:dubai-stud");
let r = await run();
check("the dry run finds the Sales, Remote (approved and waiting) and Draw closes for Bangalore — 4",
  r.code === 0 && /^4 enrolments sold for the Bangalore academy/m.test(r.out)
  && ["IN-00050", "IN-00028", "IN-00053", "IN-00060"].every((n) => r.out.includes(n)), r.out);
check("...not the Banglore CRM's, a Dubai close, a voided or a moved one", !["IN-00036", "IN-00500", "IN-00061", "IN-00062"].some((n) => r.out.includes(n)), r.out);
check("...changes nothing (no tag made)", /4 to tag\. Nothing was changed/.test(r.out) && (await tagDocs()).length === 0, r.out);
check("...says where each is: in the LMS, in CS Portal, waiting",
  /IN-00050[\s\S]*?LMS: in the LMS — move to Dubai · CS Portal: STU-0001 — move to a Dubai team/.test(r.out)
  && /IN-00053[\s\S]*?LMS: not sent \(waits for approval\)/.test(r.out), r.out);
check("...and prints the LMS command with the emails of the two already there, filled in",
  [`${sales.email},${remote.email}`, `${remote.email},${sales.email}`].some((e) => r.out.includes(`bun src/scripts/move-student-org.ts --emails=${e} --to=dubai`)), r.out);
check("...and CS Portal's with the one student there", r.out.includes(`bun src/scripts/dubai-students.ts --invoice-ids ${sales.invoiceId}`), r.out);
check("...no placeholder anywhere in them", !/<[^>]+>/.test(r.out), r.out);
r = await run("--invoice", "IN-00050,IN-00036", "--apply");
check("a number named that isn't one (the Banglore CRM's) stops it, nothing changed",
  r.code !== 0 && /IN-00036/.test(r.out) && /Nothing was changed/.test(r.out) && (await tagDocs()).length === 0, r.out);
r = await run("--invoice", "IN-00050");
check("--invoice narrows it to that one", r.code === 0 && /^1 enrolment sold/m.test(r.out) && !r.out.includes("IN-00028"), r.out);

r = await run("--apply");
const tags = await tagDocs();
check("--apply: one tag, DUBAI-STUD, in the Bangalore organization", r.code === 0 && tags.length === 1 && tags[0]!.name === "DUBAI-STUD" && String(tags[0]!.organizationId) === String(blr._id), r.out);
let all = true;
for (const e of [sales, remote, waiting, draw]) if (!(await tagged(e.invoiceId)) || !(await tagged(e.customerId, "customers"))) all = false;
check("...on each of the four invoices and their clients", all);
let none = true;
for (const e of [banglore, dubai, voided, moved]) if ((await tagged(e.invoiceId)) || (await tagged(e.customerId, "customers"))) none = false;
check("...and on none of the others", none);
r = await run();
check("run again: nothing more to tag", r.code === 0 && /0 to tag/.test(r.out) && (await tagDocs()).length === 1, r.out);

step("2. The worker");
const { drainLmsProvisions, drainLmsExtraCourses, drainCommissionStudents } = await import("../jobs/lms-provision.worker");
// The waiting one approved, and the Banglore CRM one, queued as the approval queues them.
await db.collection("invoices").updateOne({ _id: waiting.invoiceId }, { $set: { "approval.state": "approved", status: "sent" } });
await db.collection("lmsprovisions").insertMany([
  { organizationId: blr._id, invoiceId: waiting.invoiceId, invoiceNumber: "IN-00053", source: "crm", status: "pending", attempts: 0, nextAttemptAt: new Date(0),
    payload: { email: waiting.email, courseSlug: "mbt", invoiceId: String(waiting.invoiceId), academy: "bangalore", crm: "remote" },
    extraCourses: [{ slug: "mbt-2", status: "pending", attempts: 0, nextAttemptAt: new Date(0) }], createdAt: new Date() },
  { organizationId: blr._id, invoiceId: banglore.invoiceId, invoiceNumber: "IN-00036", source: "crm", status: "pending", attempts: 0, nextAttemptAt: new Date(0),
    payload: { email: banglore.email, courseSlug: "mbt", invoiceId: String(banglore.invoiceId), academy: "bangalore", crm: "banglore" }, createdAt: new Date() },
]);
await drainLmsProvisions();
const toLms = (email: string) => lmsSent.find((b) => b.email === email && b.courseSlug === "mbt");
check("a tagged enrolment goes to the LMS with dubaiStudent — its academy still Bangalore",
  toLms(waiting.email)?.dubaiStudent === true && toLms(waiting.email)?.academy === "bangalore", JSON.stringify(toLms(waiting.email)));
check("the Banglore CRM's goes without it", !!toLms(banglore.email) && toLms(banglore.email)?.dubaiStudent === undefined, JSON.stringify(toLms(banglore.email)));
await drainLmsExtraCourses();
const extra = lmsSent.find((b) => b.email === waiting.email && b.courseSlug === "mbt-2");
check("its further course goes with dubaiStudent too", extra?.dubaiStudent === true, JSON.stringify(extra));

await db.collection("lmsprovisions").updateMany({ invoiceId: { $in: [waiting.invoiceId, banglore.invoiceId] } }, { $set: { "commission.state": "pending", "commission.nextAttemptAt": new Date(0), "payload.crm": "remote" } });
await drainCommissionStudents();
const toCs = (id: unknown) => csSent.find((b) => b.invoiceId === String(id));
check("to CS Portal: the tagged one with dubaiStudent and academy Bangalore", toCs(waiting.invoiceId)?.dubaiStudent === true && toCs(waiting.invoiceId)?.academy === "bangalore", JSON.stringify(toCs(waiting.invoiceId)));
check("...the Banglore CRM's without", !!toCs(banglore.invoiceId) && toCs(banglore.invoiceId)?.dubaiStudent === undefined, JSON.stringify(toCs(banglore.invoiceId)));

// The tag taken off by hand: an ordinary Bangalore student again.
const [tag] = await tagDocs();
await db.collection("invoices").updateOne({ _id: waiting.invoiceId }, { $pull: { tagIds: tag!._id } as never });
await db.collection("lmsprovisions").updateOne({ invoiceId: waiting.invoiceId }, { $set: { status: "pending", nextAttemptAt: new Date(0) } });
const before = lmsSent.length;
await drainLmsProvisions();
const resent = lmsSent.slice(before).find((b) => b.email === waiting.email);
check("the tag taken off: sent without dubaiStudent", !!resent && resent.dubaiStudent === undefined, JSON.stringify(resent));
await db.collection("invoices").updateOne({ _id: waiting.invoiceId }, { $addToSet: { tagIds: tag!._id } as never });

step("3. Approvals");
const { approvalList } = await import("../modules/approvals/approvals.service");
const page = await approvalList({ userId: new Types.ObjectId().toString(), organizationId: String(blr._id), role: "", permissions: [], isSuperAdmin: true } as never,
  { status: "all", type: "invoice", page: 1, pageSize: 50 } as never);
const rowOf = (id: unknown) => page.rows.find((x) => x.id === String(id));
check("a tagged enrolment's row says DUBAI-STUD", rowOf(sales.invoiceId)?.dubaiStudent === true && rowOf(waiting.invoiceId)?.dubaiStudent === true, JSON.stringify(rowOf(sales.invoiceId)));
check("...the Banglore CRM's doesn't", !!rowOf(banglore.invoiceId) && rowOf(banglore.invoiceId)?.dubaiStudent === undefined, JSON.stringify(rowOf(banglore.invoiceId)));

stand.stop(true);
await mongoose.disconnect();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
