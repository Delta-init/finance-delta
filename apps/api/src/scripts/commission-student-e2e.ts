/**
 * A new LMS student going on to Tetra Commission, over real HTTP against a
 * real Tetra Commission process. The LMS is a stand-in here — its half is
 * proven by lms-provision-e2e — because what matters is what finance does
 * once the LMS has, or has not, taken the student.
 *
 *   1. New students only: nothing the LMS took before this existed, or while
 *      it was switched off, is ever sent.
 *   2. Only once the LMS has them, and never holding up the LMS step.
 *   3. The teams take turns in the order the LMS took the students.
 *   4. An email Tetra Commission already has is left alone and uses no turn.
 *   5. Down, not deployed yet, or refusing: retried, waited for, or stopped —
 *      and a retry never makes a second student.
 *   6. Forex students only: a close on another programme's course, or one
 *      the LMS names no programme for, is passed over and says why; a Forex
 *      course later on the same invoice sends the student after all.
 *
 * Run through scripts/commission-student-e2e.sh. Scratch databases only.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
const commissionUri = process.env.COMMISSION_MONGO_URI ?? "";
const commissionDb = process.env.COMMISSION_MONGO_DB ?? "";
for (const [name, value] of [["MONGODB_URI", uri], ["COMMISSION_MONGO_URI", `${commissionUri}/${commissionDb}`]]) {
  if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(value!) || !/e2e/i.test(value!)) {
    console.error(`Refusing to run: ${name} must be a scratch e2e database on 127.0.0.1, got "${value}"`);
    process.exit(1);
  }
}

const { env } = await import("../config/env");
const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
const { drainLmsProvisions, drainLmsExtraCourses, drainCommissionStudents, kickLmsProvisioning, startLmsProvisionWorker } = await import("../jobs/lms-provision.worker");

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(s: string) { console.log(`\n\x1b[1m${s}\x1b[0m`); }

/* ── A stand-in LMS: takes every enrolment, except for addresses that say it is down. Names each
   course's programme as the LMS does — Digital Marketing's is not Forex — except for a course
   that stands for an LMS older than the field, which names none. ── */
let lmsCalls = 0;
const lms = Bun.serve({
  port: Number(process.env.E2E_FAKE_LMS_PORT),
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path !== "/api/v1/integrations/finance/enrolment" || req.headers.get("x-finance-secret") !== env.LMS_S2S_SECRET) {
      // What a server without the route says — Tetra Commission's old code answers exactly this.
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    lmsCalls++;
    const body = (await req.json()) as { email: string; courseSlug: string };
    if (body.email.includes("lmsdown")) return Response.json({ success: false, error: { message: "LMS is down" } }, { status: 503 });
    const dm = body.courseSlug.startsWith("digital-marketing");
    return Response.json({
      success: true,
      data: {
        userId: new Types.ObjectId().toString(), created: true, alreadyProcessed: false,
        courseSlug: body.courseSlug, courseTitle: dm ? "Digital Marketing" : "Delta Wave Theory Trading Programme",
        ...(body.courseSlug === "from-an-older-lms" ? {} : { courseProgram: dm ? "digital-marketing" : "4x-trading" }),
        organizationSlug: null,
      },
    });
  },
});
const LMS_URL = `http://127.0.0.1:${lms.port}`;
const COMMISSION_URL = env.COMMISSION_API_URL;
const SECRET = env.COMMISSION_S2S_SECRET;

await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const tc = await mongoose.createConnection(commissionUri, { dbName: commissionDb }).asPromise();
if (tc.host !== "127.0.0.1" || mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
// Emptied, not dropped: Tetra Commission made its indexes when it started.
for (const c of await tc.db!.listCollections().toArray()) await tc.db!.collection(c.name).deleteMany({});
const students = tc.db!.collection("students");

step("Setting up");
const chief = (full_name: string, created_date: string) => ({
  _id: new Types.ObjectId(), email: `${full_name.toLowerCase().replace(/\s+/g, ".")}@e2e-test.com`, full_name,
  app_role: "chief_mentor", password_hash: "x", created_date, updated_date: created_date,
});
// Four teams as the Teams page has them: each a Chief with somebody under them.
const chiefs = [
  chief("Chief One", "2026-01-01T00:00:00.000Z"), chief("Chief Two", "2026-02-01T00:00:00.000Z"),
  chief("Chief Three", "2026-03-01T00:00:00.000Z"), chief("Chief Four", "2026-04-01T00:00:00.000Z"),
];
await tc.db!.collection("users").insertMany([
  ...chiefs,
  ...chiefs.map((c) => ({
    ...chief(`${c.full_name} Member`, c.created_date), app_role: "junior_mentor", up_head_id: String(c._id), up_head_name: c.full_name,
  })),
]);
await students.insertOne({
  student_code: "STU-0042", full_name: "Already Here", email: "already@e2e-test.com",
  primary_mentor_id: "someone", primary_mentor_name: "Hand Added", assignment_status: "assigned",
  status: "ACTIVE", student_level: "LEVEL_2", notes: "added by a mentor",
});
const orgId = new Types.ObjectId();
let n = 0;
/**
 * An approved CRM enrolment, queued the way the approval queues it — the invoice's other courses in `extra`, and the
 * language the close recorded on the invoice's enrolment in `language`.
 */
async function enrol(email?: string, opts: { courseSlug?: string; extra?: string[]; language?: string; crm?: string; source?: string; externalId?: string; meetingBy?: string; meetingByEmail?: string } = {}) {
  n++;
  const invoiceId = new Types.ObjectId();
  const customerId = new Types.ObjectId();
  // Customer codes are unique per organization, so each stand-in carries its own.
  await mongoose.connection.db!.collection("customers").insertOne({ _id: customerId, organizationId: orgId, customerCode: `CUST-E2E-${n}`, name: `Student ${n}`, country: "India" });
  await mongoose.connection.db!.collection("invoices").insertOne({
    _id: invoiceId, customerId, invoiceNumber: `INV-${String(n).padStart(4, "0")}`,
    ...(opts.language !== undefined || opts.crm || opts.meetingBy
      ? {
        enrolment: {
          ...(opts.language !== undefined ? { language: opts.language } : {}), ...(opts.crm ? { crm: opts.crm } : {}),
          // The CRM's rep, as the close kept them: their name, and their email there when it was kept.
          ...(opts.meetingBy ? { meetingBy: opts.meetingBy } : {}), ...(opts.meetingByEmail ? { meetingByEmail: opts.meetingByEmail } : {}),
        },
      }
      : {}),
    // The CRM's own source, which the tag falls back on where the CRM said nothing — and its own id, by
    // which it asks after the enrolment (My Enrolments).
    ...(opts.source ? { organizationId: orgId, external: { source: opts.source, ...(opts.externalId ? { externalId: opts.externalId } : {}) } } : {}),
  });
  return LmsProvision.create({
    organizationId: orgId, invoiceId, invoiceNumber: `INV-${String(n).padStart(4, "0")}`,
    // Whose enrolment it is, as the approval records it: which decides whether Tetra Commission gets the student.
    ...(opts.source ? { source: opts.source } : {}),
    payload: {
      email: email ?? `student${n}@e2e-test.com`, name: `Student ${n}`, phone: `+9199000${String(n).padStart(5, "0")}`,
      courseSlug: opts.courseSlug ?? "delta-wave-theory", invoiceId: String(invoiceId), invoiceNumber: `INV-${String(n).padStart(4, "0")}`,
      amount: 4500, paymentStatus: "partial",
    },
    ...(opts.extra ? { extraCourses: opts.extra.map((slug) => ({ slug, status: "pending", nextAttemptAt: new Date() })) } : {}),
  });
}
const row = async (id: unknown) => (await LmsProvision.findById(id).lean()) as any;
const studentFor = async (id: unknown) => students.findOne({ finance_invoice_id: String((await row(id)).invoiceId) }) as any;
check("four teams in Tetra Commission, and a student a mentor added by hand", true);

step("New students only");
// Taken by the LMS before this existed: sent, and nothing about Tetra Commission on it.
const before = await enrol();
await LmsProvision.updateOne({ _id: before._id }, { $set: { status: "sent", sentAt: new Date(Date.now() - 86_400_000), lmsUserId: "old" } });
env.COMMISSION_API_URL = "";
env.LMS_API_URL = LMS_URL;
const whileOff = await enrol();
await drainLmsProvisions();
check("while Tetra Commission is switched off, the LMS still gets the student", (await row(whileOff._id)).status === "sent");
env.COMMISSION_API_URL = COMMISSION_URL;
await drainCommissionStudents();
check("...but neither that student nor one from before is sent once it is switched on",
  !(await studentFor(whileOff._id)) && !(await studentFor(before._id)) && (await students.countDocuments()) === 1);

step("Five new students, in the order the LMS took them");
const five = [];
for (let i = 0; i < 5; i++) five.push(await enrol());
const lmsBefore = lmsCalls;
await drainLmsProvisions();
check("the LMS got all five first", lmsCalls - lmsBefore === 5 && (await Promise.all(five.map((r) => row(r._id)))).every((r) => r.status === "sent"));
const marked = await Promise.all(five.map((r) => row(r._id)));
check("...and each is marked for Tetra Commission", marked.every((r) => r.commission?.state === "pending"), JSON.stringify(marked.map((r) => r.commission)));
const sent = await drainCommissionStudents();
const after = await Promise.all(five.map((r) => row(r._id)));
check("all five sent", sent === 5 && after.every((r) => r.commission?.state === "sent" && r.commission?.alreadyThere === false), JSON.stringify(after.map((r) => r.commission)));
const teams = after.map((r) => r.commission?.team);
check("team 1, 2, 3, 4, then team 1 again", JSON.stringify(teams) === JSON.stringify(["Chief One", "Chief Two", "Chief Three", "Chief Four", "Chief One"]), JSON.stringify(teams));
check("...each with the team's leader as their mentor", after.every((r) => r.commission?.mentorName === r.commission?.team));
check("codes carry on from the highest there (STU-0042)", JSON.stringify(after.map((r) => r.commission?.studentCode)) ===
  JSON.stringify(["STU-0043", "STU-0044", "STU-0045", "STU-0046", "STU-0047"]), JSON.stringify(after.map((r) => r.commission?.studentCode)));
const s = await studentFor(five[0]!._id);
check("the student there is who finance sent",
  s?.full_name === "Student 3" && s?.email === "student3@e2e-test.com" && s?.phone === "+919900000003" && s?.country === "India" &&
  s?.status === "ACTIVE" && s?.student_level === "LEVEL_1" && s?.primary_mentor_name === "Chief One", JSON.stringify(s));
check("...with the course the LMS named and the invoice", s?.notes === "From Delta LMS — Delta Wave Theory Trading Programme, invoice INV-0003" &&
  s?.lms_user_id === after[0].lmsUserId, s?.notes);

step("An email Tetra Commission already has");
const again = await enrol("already@e2e-test.com");
await drainLmsProvisions();
await drainCommissionStudents();
const againRow = await row(again._id);
check("recorded as sent, and as already there", againRow.commission?.state === "sent" && againRow.commission?.alreadyThere === true &&
  againRow.commission?.studentCode === "STU-0042" && againRow.commission?.mentorName === "Hand Added", JSON.stringify(againRow.commission));
const kept = await students.findOne({ email: "already@e2e-test.com" }) as any;
check("...and left exactly as it was", kept?.primary_mentor_name === "Hand Added" && kept?.student_level === "LEVEL_2" && kept?.notes === "added by a mentor");
const next = await enrol();
await drainLmsProvisions();
await drainCommissionStudents();
check("it used up no turn: the next new student goes to team 2", (await row(next._id)).commission?.mentorName === "Chief Two");

step("A retry never makes a second student");
await LmsProvision.updateOne({ _id: five[0]!._id }, { $set: { "commission.state": "pending", "commission.nextAttemptAt": new Date() } });
await drainCommissionStudents();
const retried = await row(five[0]!._id);
check("sent again, the same student comes back — still finance's own, not somebody already there",
  retried.commission?.studentCode === "STU-0043" && retried.commission?.alreadyThere === false && retried.commission?.team === "Chief One" &&
  (await students.countDocuments({ finance_invoice_id: String(five[0]!.invoiceId) })) === 1, JSON.stringify(retried.commission));

step("Tetra Commission down, not deployed, or refusing");
env.COMMISSION_API_URL = "http://127.0.0.1:1";
const down = await enrol();
await drainLmsProvisions();
await drainCommissionStudents();
let d = await row(down._id);
check("down: the LMS step is untouched", d.status === "sent");
check("...and the student waits to be retried, later", d.commission?.state === "pending" && d.commission?.attempts === 1 &&
  !!d.commission?.lastError && new Date(d.commission?.nextAttemptAt) > new Date(), JSON.stringify(d.commission));
await LmsProvision.updateOne({ _id: down._id }, { $set: { "commission.attempts": 12, "commission.nextAttemptAt": new Date() } });
await drainCommissionStudents();
d = await row(down._id);
check("...down past eight tries: still waiting, never given up", d.commission?.state === "pending" && d.commission?.attempts === 13, JSON.stringify(d.commission));
env.COMMISSION_API_URL = COMMISSION_URL;
await LmsProvision.updateOne({ _id: down._id }, { $set: { "commission.nextAttemptAt": new Date() } });
await drainCommissionStudents();
d = await row(down._id);
check("...back up: sent, to the next team in turn", d.commission?.state === "sent" && d.commission?.mentorName === "Chief Three", JSON.stringify(d.commission));

env.COMMISSION_API_URL = LMS_URL; // answers 404 {"error":"Not found"}, like a server still on the old code
const early = await enrol();
await drainLmsProvisions();
await LmsProvision.updateOne({ _id: early._id }, { $set: { "commission.attempts": 20 } });
await drainCommissionStudents();
let e = await row(early._id);
check("not deployed yet (404): waited for however long it takes, never given up",
  e.commission?.state === "pending" && e.commission?.attempts === 21 && /Not found/.test(e.commission?.lastError ?? ""), JSON.stringify(e.commission));
env.COMMISSION_API_URL = COMMISSION_URL;
await LmsProvision.updateOne({ _id: early._id }, { $set: { "commission.nextAttemptAt": new Date() } });
await drainCommissionStudents();
e = await row(early._id);
check("...deployed: sent", e.commission?.state === "sent" && e.commission?.mentorName === "Chief Four", JSON.stringify(e.commission));

env.COMMISSION_S2S_SECRET = "not-the-secret";
const refused = await enrol();
await drainLmsProvisions();
await drainCommissionStudents();
const f = await row(refused._id);
check("a wrong secret: stopped, with the reason — it will not come right by retrying",
  f.commission?.state === "failed" && /Bad secret/.test(f.commission?.lastError ?? ""), JSON.stringify(f.commission));
env.COMMISSION_S2S_SECRET = SECRET;

step("Only once the LMS has them");
const lmsDown = await enrol("lmsdown@e2e-test.com");
await drainLmsProvisions();
await drainCommissionStudents();
const g = await row(lmsDown._id);
check("the LMS refusing: nothing goes to Tetra Commission", g.status === "pending" && !g.commission?.state && !(await students.findOne({ email: "lmsdown@e2e-test.com" })));
await LmsProvision.updateOne({ _id: lmsDown._id }, { $set: { attempts: 12, nextAttemptAt: new Date() } });
await drainLmsProvisions();
const g2 = await row(lmsDown._id);
check("the LMS down past eight tries: still waiting, never given up", g2.status === "pending" && g2.attempts === 13, JSON.stringify({ status: g2.status, attempts: g2.attempts }));

step("The course's fees go with the student, for the mentors to see");
{
  env.COMMISSION_API_URL = COMMISSION_URL;
  const summary = (feeMinor: number, paidMinor: number, extra: Record<string, unknown> = {}) => ({
    currency: "AED", feeMinor, paidMinor, balanceMinor: Math.max(0, feeMinor - paidMinor),
    bonus: { given: true, amountMinor: 25_000 },
    receipt: { url: "https://files.example.com/enrolment-receipts/lead-7/1-receipt.jpg", name: "receipt.jpg", mimeType: "image/jpeg" },
    ...extra,
  });
  /** An approved enrolment that carries its money, as the approval queues one now. */
  const enrolWithFees = async (feeSummary: unknown, email?: string) => {
    const r = await enrol(email);
    await LmsProvision.updateOne({ _id: r._id }, { $set: { "payload.feeSummary": feeSummary } });
    return r;
  };

  const first = await enrolWithFees(summary(130_000, 50_000), "fees@e2e-test.com");
  await drainLmsProvisions();
  await drainCommissionStudents();
  const created = await students.findOne({ email: "fees@e2e-test.com" }) as any;
  const f0 = created?.course_fees?.[0];
  check("Case 1 — a new student arrives with the course's fee, what was paid and the balance",
    created?.course_fees?.length === 1 && f0?.fee_minor === 130_000 && f0?.paid_minor === 50_000 && f0?.balance_minor === 80_000 && f0?.currency === "AED",
    JSON.stringify(created?.course_fees));
  check("...the bonus given at the close, and the receipt", f0?.bonus_given === true && f0?.bonus_minor === 25_000 &&
    f0?.receipt_url === "https://files.example.com/enrolment-receipts/lead-7/1-receipt.jpg", JSON.stringify(f0));
  check("...against the invoice and the course it paid for",
    f0?.invoice_id === String(first.invoiceId) && f0?.invoice_number === first.invoiceNumber && f0?.course === "Delta Wave Theory Trading Programme", JSON.stringify(f0));
  check("...and the bonus is information only: no funding request is made for it",
    (await tc.db!.collection("funding_transactions").countDocuments({})) === 0);

  // Their second course: same person, their own mentor kept — the course is added.
  const second = await enrolWithFees(summary(450_000, 0, { bonus: { given: false, amountMinor: 0 }, receipt: null }), "fees@e2e-test.com");
  await drainLmsProvisions();
  await drainCommissionStudents();
  const same = await students.findOne({ email: "fees@e2e-test.com" }) as any;
  check("Case 1 — a second course adds its own entry to the student already there",
    same?.course_fees?.length === 2 && same.course_fees[1]?.invoice_id === String(second.invoiceId) && same.course_fees[1]?.fee_minor === 450_000,
    JSON.stringify(same?.course_fees));
  check("...without touching who they are or who mentors them",
    same?.primary_mentor_name === created?.primary_mentor_name && same?.student_code === created?.student_code && (await students.countDocuments({ email: "fees@e2e-test.com" })) === 1);
  check("Case 2 — \"no bonus\" and no receipt are recorded as such",
    same?.course_fees[1]?.bonus_given === false && same.course_fees[1]?.bonus_minor === 0 && same.course_fees[1]?.receipt_url === "", JSON.stringify(same?.course_fees[1]));

  // Finance retrying the first: one entry still.
  await LmsProvision.updateOne({ _id: first._id }, { $set: { "commission.state": "pending", "commission.nextAttemptAt": new Date() } });
  await drainCommissionStudents();
  check("Case 2 — a retry adds nothing twice",
    ((await students.findOne({ email: "fees@e2e-test.com" })) as any)?.course_fees?.length === 2);

  // What does not add up is dropped, never the student.
  const bad = await enrolWithFees({ currency: "AED", feeMinor: -5, paidMinor: 0, balanceMinor: 0 }, "badfees@e2e-test.com");
  await drainLmsProvisions();
  await drainCommissionStudents();
  const badStudent = await students.findOne({ email: "badfees@e2e-test.com" }) as any;
  check("Case 3 — a malformed summary is ignored, and the student still arrives",
    (await row(bad._id)).commission?.state === "sent" && Boolean(badStudent) && (badStudent?.course_fees ?? []).length === 0,
    JSON.stringify({ state: (await row(bad._id)).commission?.state, fees: badStudent?.course_fees }));
  const sneaky = await enrolWithFees(summary(130_000, 0, { receipt: { url: "javascript:alert(1)", name: "x" } }), "sneaky@e2e-test.com");
  await drainLmsProvisions();
  await drainCommissionStudents();
  const sneakyStudent = await students.findOne({ email: "sneaky@e2e-test.com" }) as any;
  check("Case 3 — a receipt that is not a web link is not kept as one",
    (await row(sneaky._id)).commission?.state === "sent" && sneakyStudent?.course_fees?.[0]?.receipt_url === "", JSON.stringify(sneakyStudent?.course_fees));
}

step("Forex students only");
{
  env.COMMISSION_API_URL = COMMISSION_URL;
  check("a Forex close keeps the programme the LMS named", (await row(five[0]!._id)).lmsCourseProgram === "4x-trading");
  const dmClose = await enrol("dm@e2e-test.com", { courseSlug: "digital-marketing" });
  const oldLms = await enrol("oldlms@e2e-test.com", { courseSlug: "from-an-older-lms" });
  await drainLmsProvisions();
  await drainCommissionStudents();
  const dmRow = await row(dmClose._id), oldRow = await row(oldLms._id);
  check("a Digital Marketing close: in the LMS, not in Tetra Commission — passed over, and says why",
    dmRow.status === "sent" && dmRow.commission?.state === "skipped" && dmRow.commission?.reason === "Not a Forex course (digital-marketing)" &&
    dmRow.lmsCourseProgram === "digital-marketing" && !(await students.findOne({ email: "dm@e2e-test.com" })), JSON.stringify(dmRow.commission));
  check("an LMS that names no programme: not sent either, and said so",
    oldRow.status === "sent" && oldRow.commission?.state === "skipped" && /did not say/.test(oldRow.commission?.reason ?? "") &&
    !(await students.findOne({ email: "oldlms@e2e-test.com" })), JSON.stringify(oldRow.commission));

  const bundle = await enrol("bundle@e2e-test.com", { courseSlug: "digital-marketing", extra: ["delta-wave-theory"] });
  await drainLmsProvisions();
  await drainCommissionStudents();
  check("Digital Marketing first and a Forex course second: passed over at first",
    (await row(bundle._id)).commission?.state === "skipped" && !(await students.findOne({ email: "bundle@e2e-test.com" })));
  await drainLmsExtraCourses();
  await drainCommissionStudents();
  const br = await row(bundle._id);
  const bs = await students.findOne({ email: "bundle@e2e-test.com" }) as any;
  check("...then sent once the Forex course is in, under that course",
    br.commission?.state === "sent" && br.commission?.course === "Delta Wave Theory Trading Programme" && !br.commission?.reason &&
    /Delta Wave Theory Trading Programme/.test(bs?.notes ?? ""), JSON.stringify({ commission: br.commission, notes: bs?.notes }));
  const count = await students.countDocuments();
  await drainLmsExtraCourses();
  await drainCommissionStudents();
  check("...once", (await students.countDocuments()) === count && (await students.countDocuments({ email: "bundle@e2e-test.com" })) === 1);
}

step("The language they study in, from the close");
{
  env.COMMISSION_API_URL = COMMISSION_URL;
  const ml = await enrol("lang@e2e-test.com", { language: "MALAYALAM" });
  await LmsProvision.updateOne({ _id: ml._id }, { $set: { "payload.feeSummary": { currency: "AED", feeMinor: 100_000, paidMinor: 100_000, balanceMinor: 0 } } });
  await enrol("nolang@e2e-test.com", { language: "Not specified" });
  await drainLmsProvisions();
  await drainCommissionStudents();
  const first = await students.findOne({ email: "lang@e2e-test.com" }) as any;
  check("a close in Malayalam, typed the old way: the student studies in Malayalam", first?.language === "Malayalam", JSON.stringify(first?.language));
  check("...and that course says so on its fees", first?.course_fees?.[0]?.language === "Malayalam", JSON.stringify(first?.course_fees));
  const none = await students.findOne({ email: "nolang@e2e-test.com" }) as any;
  check("\"Not specified\": no language", !!none && !none.language, JSON.stringify(none?.language));
  // Their next course, closed in English: their latest close.
  await enrol("lang@e2e-test.com", { language: "English" });
  await drainLmsProvisions();
  await drainCommissionStudents();
  const now = await students.findOne({ email: "lang@e2e-test.com" }) as any;
  const line = await tc.db!.collection("student_history").findOne({ student_id: String(now?._id), type: "details_changed" }) as any;
  check("a second close in English: they study in English now, and their history says so",
    now?.language === "English" && /Language: Malayalam → English/.test(line?.text ?? "") && line?.by_name === "Delta finance",
    JSON.stringify({ language: now?.language, history: line?.text }));
}

step("Which sales CRM sold it");
{
  env.COMMISSION_API_URL = COMMISSION_URL;
  const remote = await enrol("remote.crm@e2e-test.com", { crm: "remote", source: "crm" });
  await LmsProvision.updateOne({ _id: remote._id }, { $set: { "payload.feeSummary": { currency: "AED", feeMinor: 100_000, paidMinor: 100_000, balanceMinor: 0 } } });
  await enrol("older.crm@e2e-test.com", { source: "crm" });
  await drainLmsProvisions();
  await drainCommissionStudents();
  const r = await students.findOne({ email: "remote.crm@e2e-test.com" }) as any;
  check("Case 1 — a student the Remote CRM sold arrives tagged so, on the student and on the course's fees",
    r?.sales_crm === "remote" && r?.course_fees?.[0]?.sales_crm === "remote", JSON.stringify({ crm: r?.sales_crm, fees: r?.course_fees }));
  const o = await students.findOne({ email: "older.crm@e2e-test.com" }) as any;
  check("Case 2 — one from a CRM that said nothing arrives as the Sales CRM's, by its source", o?.sales_crm === "delta", JSON.stringify(o?.sales_crm));
}

step("Who closed it");
{
  env.COMMISSION_API_URL = COMMISSION_URL;
  await enrol("closed.remote@e2e-test.com", { crm: "remote", source: "crm", meetingBy: "Aisha Rep", meetingByEmail: "aisha.rep@crm.e2e-test.com" });
  await enrol("closed.before@e2e-test.com", { crm: "delta", source: "crm", meetingBy: "Old Rep" });
  await drainLmsProvisions();
  await drainCommissionStudents();
  const a = await students.findOne({ email: "closed.remote@e2e-test.com" }) as any;
  check("Case 1 — the student arrives with the rep who closed them: their email in the CRM, their name and the CRM",
    JSON.stringify(a?.closed_by) === JSON.stringify([{ email: "aisha.rep@crm.e2e-test.com", name: "Aisha Rep", crm: "remote" }]), JSON.stringify(a?.closed_by));
  const b = await students.findOne({ email: "closed.before@e2e-test.com" }) as any;
  check("Case 2 — a close from before the rep's email was kept: the student, with nobody named", !!b && !b.closed_by, JSON.stringify(b?.closed_by));
}

step("What a sales CRM's My Enrolments sees — the LMS, and who looks after them");
{
  const { enrolmentStatusesFor } = await import("../modules/integrations/enrolment-status.service");
  const ask = async (id: string) => (await enrolmentStatusesFor(orgId, "draw-crm", [id]))[0];
  const drawSale = await enrol("draw.buyer@e2e-test.com", { crm: "draw", source: "draw-crm", externalId: "draw-enrol-1" });
  await drainLmsProvisions();
  await drainCommissionStudents();
  const there = await students.findOne({ email: "draw.buyer@e2e-test.com" }) as any;
  check("Case 1 — Draw's Forex student goes on to Tetra Commission now, like Delta's",
    (await row(drawSale._id)).commission?.state === "sent" && there?.student_code === (await row(drawSale._id)).commission?.studentCode,
    JSON.stringify((await row(drawSale._id)).commission));
  const st = await ask("draw-enrol-1");
  check("Case 1 — in the LMS: a new account, on the course", st?.lms?.state === "created" && st.lms.courses[0] === "Delta Wave Theory Trading Programme",
    JSON.stringify(st?.lms));
  // Given to a CS there, as the round or a CS Manager would — whatever the teams above made of it.
  await students.updateOne({ _id: there._id }, { $set: { assignment_status: "assigned", primary_mentor_name: "Asha CS", team_name: "Team Asha" } });
  const assigned = await ask("draw-enrol-1");
  check("...their code, CS and CS team, as Tetra Commission has them now",
    assigned?.commission?.state === "sent" && assigned.commission.code === there?.student_code && assigned.commission.cs === "Asha CS"
      && assigned.commission.team === "Team Asha" && assigned.commission.live === true, JSON.stringify(assigned?.commission));
  await students.updateOne({ _id: there._id }, { $set: { primary_mentor_name: "Another CS", team_name: "Another Team" } });
  const moved = await ask("draw-enrol-1");
  check("Case 1 — given to another CS there: said at once", moved?.commission?.cs === "Another CS" && moved.commission.team === "Another Team",
    JSON.stringify(moved?.commission));
  await students.updateOne({ _id: there._id }, { $set: { assignment_status: "open_pool", primary_mentor_name: "", team_name: "" } });
  const pooled = await ask("draw-enrol-1");
  check("Case 2 — back in Delta Open Students: no CS, still their code", pooled?.commission?.cs === "" && pooled.commission.code === there?.student_code
    && pooled.commission.live === true, JSON.stringify(pooled?.commission));
  env.COMMISSION_API_URL = "http://127.0.0.1:1";
  const offline = await ask("draw-enrol-1");
  env.COMMISSION_API_URL = COMMISSION_URL;
  const told = (await row(drawSale._id)).commission;
  check("Case 2 — Tetra Commission not answering: what finance was told when it sent them, marked so",
    offline?.commission?.live === false && offline.commission.cs === (told?.mentorName ?? "") && offline.commission.team === (told?.team ?? "")
      && offline.commission.code === there?.student_code, JSON.stringify(offline?.commission));
  await students.deleteOne({ _id: there._id });
  const gone = await ask("draw-enrol-1");
  check("Case 3 — taken out of Tetra Commission since: said so, with no CS", gone?.commission?.live === true && gone.commission.cs === ""
    && /no longer/i.test(gone.commission.detail ?? ""), JSON.stringify(gone?.commission));
  await mongoose.connection.db!.collection("invoices").insertOne({ organizationId: orgId, invoiceNumber: "INV-WAIT", external: { source: "draw-crm", externalId: "draw-enrol-2" } });
  const waiting = await ask("draw-enrol-2");
  check("Case 2 — not approved yet: nothing asked of the LMS or Tetra Commission", !!waiting && waiting.lms === null && waiting.commission === null,
    JSON.stringify(waiting));
  const marketing = await enrol("draw.marketing@e2e-test.com", { courseSlug: "digital-marketing", crm: "draw", source: "draw-crm", externalId: "draw-enrol-3" });
  await drainLmsProvisions();
  const dm = await ask("draw-enrol-3");
  check("Case 2 — not a Forex course: in the LMS, and Tetra Commission says why not",
    dm?.lms?.state === "created" && dm.commission?.state === "skipped" && /forex/i.test(dm.commission.detail ?? ""), JSON.stringify(dm));
  await LmsProvision.updateOne({ _id: marketing._id }, { $set: { status: "unmapped", lastError: "No LMS course" } });
  const unmapped = await ask("draw-enrol-3");
  check("Case 3 — on a course no LMS course is linked to: said so, rather than waiting for ever",
    unmapped?.lms?.state === "unmapped" && /not linked/i.test(unmapped.lms.detail ?? ""), JSON.stringify(unmapped?.lms));
  check("Case 3 — another CRM's ids, or none: nothing", (await enrolmentStatusesFor(orgId, "crm", ["draw-enrol-1"])).length === 0
    && (await enrolmentStatusesFor(orgId, "draw-crm", [])).length === 0);
}

step("Sent the moment it is approved");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => Promise<boolean>, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return true; await wait(50); }
  return false;
};
const quiet = await enrol();
kickLmsProvisioning();
await wait(700);
check("a process that does not run the worker sends nothing on a kick (its timer elsewhere will)", (await row(quiet._id)).status === "pending");
startLmsProvisionWorker();
const t0 = Date.now();
kickLmsProvisioning();
const both = await until(async () => { const r = await row(quiet._id); return r.status === "sent" && r.commission?.state === "sent"; });
check("in the process that runs it, a kick alone takes it into the LMS and Tetra Commission within seconds",
  both && Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
const another = await enrol();
const t1 = Date.now();
kickLmsProvisioning();
check("...and the next one the same way", await until(async () => (await row(another._id)).commission?.state === "sent") && Date.now() - t1 < 3000, `${Date.now() - t1} ms`);

await tc.db!.dropDatabase();
await tc.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
lms.stop(true);
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
