/**
 * backfill-lms-provisions.ts --invoice (the user, 2026-11-19: "backfill this student" — its course linked to an LMS
 * course after the close was approved): against a scratch database, the script run as somebody would run it.
 *
 *   1. A number not found, or one in two organizations, stops the run before anything changes; --org settles which.
 *   2. The dry run says what it would do and changes nothing.
 *   3. --apply: the named invoice gets its LMS course and a pending provisioning row; every other stuck enrolment —
 *      the same course included — is left exactly as it was. Run again: nothing more.
 *   4. Without --invoice, as before: every unmapped row counted.
 *
 * Run through scripts/backfill-lms-invoice-e2e.sh (a throwaway mongod; nothing reads a .env).
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

await mongoose.connect(uri);
const db = mongoose.connection.db!;
for (const c of await db.listCollections().toArray()) await db.collection(c.name).deleteMany({});
const { Types } = mongoose;

const orgA = { _id: new Types.ObjectId(), name: "Delta HQ E2E", createdAt: new Date() };
const orgB = { _id: new Types.ObjectId(), name: "Delta Banglore E2E", createdAt: new Date() };
await db.collection("organizations").insertMany([orgA, orgB]);

const approvedAt = new Date("2026-11-19T08:52:23Z");
let seq = 0;
async function enrolment(org: typeof orgA, invoiceNumber: string, course: string, email: string) {
  const customerId = new Types.ObjectId();
  await db.collection("customers").insertOne({ _id: customerId, organizationId: org._id, name: `Client ${++seq}`, email, createdAt: new Date() });
  const invoiceId = new Types.ObjectId();
  await db.collection("invoices").insertOne({
    _id: invoiceId, organizationId: org._id, invoiceNumber, customerId, customerName: `Client ${seq}`, currency: "AED", status: "paid",
    totalMinor: 25000, amountPaidMinor: 25000, balanceMinor: 0,
    lineItems: [{ description: course, quantity: 1, unitPriceMinor: 25000, amountMinor: 25000 }],
    approval: { state: "approved", at: approvedAt },
    external: { source: "crm", externalId: new Types.ObjectId().toString() },
    // The course as the CRM sent it at the close — before it was linked to an LMS course.
    enrolment: { course, courses: [{ name: course, lmsCourseSlugs: [] }], academy: "dubai", crm: "remote" },
    createdAt: new Date(),
  });
  await db.collection("lmsprovisions").insertOne({
    organizationId: org._id, invoiceId, invoiceNumber, source: "crm", payload: {}, status: "unmapped",
    lastError: "No LMS course on this invoice — no catalogue item maps to one, and the enrolment named none", createdAt: new Date(),
  });
  return invoiceId;
}
const target = await enrolment(orgA, "IN-00464", "CMA REGISTRATION", "target@e2e-backfill.test");
const sameCourse = await enrolment(orgA, "IN-00463", "CMA REGISTRATION", "same-course@e2e-backfill.test");
const otherCourse = await enrolment(orgA, "IN-00334", "Ai Academy Softeware Mastery", "other-course@e2e-backfill.test");
const sharedA = await enrolment(orgA, "IN-00031", "CMA REGISTRATION", "shared-a@e2e-backfill.test");
const sharedB = await enrolment(orgB, "IN-00031", "CMA REGISTRATION", "shared-b@e2e-backfill.test");

async function run(...args: string[]) {
  const p = Bun.spawn(["bun", "--no-env-file", "src/scripts/backfill-lms-provisions.ts", ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}
const rowOf = async (invoiceId: unknown) => db.collection("lmsprovisions").findOne({ invoiceId });
const rowsOf = async (invoiceId: unknown) => db.collection("lmsprovisions").countDocuments({ invoiceId });
const slugOf = async (invoiceId: unknown) => ((await db.collection("invoices").findOne({ _id: invoiceId as never })) as any)?.enrolment?.lmsCourseSlug;
const untouched = async () => {
  for (const id of [target, sameCourse, otherCourse, sharedA, sharedB]) {
    if ((await rowOf(id))?.status !== "unmapped" || (await slugOf(id))) return false;
  }
  return true;
};
const cma = ["--course-slug", "CMA REGISTRATION=cma-us", "--requeue-unmapped"];

step("1. Not found, or in two organizations: nothing runs");
let r = await run("--invoice", "IN-99999", ...cma, "--apply");
check("a number that isn't an approved enrolment: stops, says so, nothing changed",
  r.code !== 0 && /IN-99999: not an approved enrolment/.test(r.out) && /Nothing was changed/.test(r.out) && (await untouched()), r.out);
r = await run("--invoice", "IN-00464,IN-99999", ...cma, "--apply");
check("one good and one wrong: still nothing", r.code !== 0 && (await untouched()), r.out);
r = await run("--invoice", "IN-00031", ...cma, "--apply");
check("a number two organizations have: stops, naming both", r.code !== 0 && /IN-00031 is in 2 organizations/.test(r.out)
  && r.out.includes("Delta HQ E2E") && r.out.includes("Delta Banglore E2E") && (await untouched()), r.out);
r = await run("--invoice", "IN-00031", "--org", "nobody", ...cma);
check("--org that names no organization: stops", r.code !== 0 && /names no organization/.test(r.out), r.out);
r = await run("--invoice", "IN-00031", "--org", "delta banglore e2e", ...cma);
check("--org by name (any case): that one, dry", r.code === 0 && /only IN-00031/.test(r.out) && /would set "CMA REGISTRATION" → cma-us on 1 invoice/.test(r.out) && (await untouched()), r.out);
r = await run("--invoice", "IN-00031", "--org", String(orgB._id), ...cma);
check("--org by id: the same", r.code === 0 && /would clear and requeue 1\b/.test(r.out), r.out);
r = await run("--invoice");
check("--invoice with no number: stops", r.code !== 0 && /--invoice needs an invoice number/.test(r.out), r.out);

step("2. The dry run");
r = await run("--invoice", "in-00464", ...cma);
check("says what it would do, for that invoice only — the number in any case", r.code === 0 && /only IN-00464/.test(r.out)
  && /would set "CMA REGISTRATION" → cma-us on 1 invoice/.test(r.out) && /would clear and requeue 1\b/.test(r.out), r.out);
check("…and changes nothing", await untouched());

step("3. --apply");
r = await run("--invoice", "IN-00464", ...cma, "--apply");
const row = (await rowOf(target)) as any;
check("ran", r.code === 0 && /requeued 1\b/.test(r.out), r.out);
check("the invoice names its LMS course now", (await slugOf(target)) === "cma-us");
check("its provisioning row is pending, for that course and the client's email — once",
  row?.status === "pending" && row?.payload?.courseSlug === "cma-us" && row?.payload?.email === "target@e2e-backfill.test" && (await rowsOf(target)) === 1, JSON.stringify(row));
let others = true;
for (const id of [sameCourse, otherCourse, sharedA, sharedB]) {
  if ((await rowOf(id))?.status !== "unmapped" || (await slugOf(id))) others = false;
}
check("every other stuck enrolment untouched — the same course's too", others);
r = await run("--invoice", "IN-00464", ...cma, "--apply");
check("run again: nothing more — no second row", r.code === 0 && /No unmapped rows to requeue/.test(r.out) && (await rowsOf(target)) === 1
  && (await rowOf(target))?.status === "pending", r.out);

step("4. Without --invoice, as before");
r = await run("--requeue-unmapped");
check("every unmapped row is counted", r.code === 0 && /would clear and requeue 4\b/.test(r.out) && !/only /.test(r.out), r.out);

console.log(`\n${pass}/${pass + fail} checks passed`);
await mongoose.disconnect();
process.exit(fail ? 1 : 0);
