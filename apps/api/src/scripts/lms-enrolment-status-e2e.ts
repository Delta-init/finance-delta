/**
 * POST /api/v1/lms/enrolment-status, against a running API and its database.
 *
 * The Delta LMS asks this for a page of its Students Requests: per email,
 * whether finance knows the student and where the enrolment requests a sales
 * CRM sent for them stand. Pinned here:
 *
 *   A. only the LMS gets an answer: no secret or a wrong one is a 401;
 *   B. the requests: pending, approved and returned (with its reason), each
 *      with its CRM (as the CRM said, or worked out from the source), who
 *      closed it and the course — newest first, across organizations;
 *   C. what is not a request: an invoice typed in finance, a voided one, one
 *      from a system that is not a sales CRM, one with no enrolment;
 *   D. emails finance knows with no request, does not know, has archived, and
 *      ones typed with capitals and spaces; ones that are not emails;
 *   E. the batch: at most 10 requests an email, 100 emails a call (101 is a
 *      400, as is no list at all).
 *
 * Run through scripts/lms-enrolment-status-e2e.sh, which starts the API.
 */
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost)[:/]/.test(uri) || !/e2e/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a throwaway e2e database on this machine, got "${uri}"`);
  process.exit(1);
}
const API = `http://127.0.0.1:${process.env.E2E_API_PORT}/api/v1`;
const SECRET = process.env.E2E_LMS_SECRET ?? "";

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const j = (v: unknown) => JSON.stringify(v);

async function ask(body: unknown, secret: string | null = SECRET) {
  const res = await fetch(`${API}/lms/enrolment-status`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret !== null ? { "x-lms-secret": secret } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, any> | null };
}

await mongoose.connect(uri);
const db = mongoose.connection.db!;
const hq = new Types.ObjectId();
const bangalore = new Types.ObjectId();
await db.collection("organizations").insertMany([
  { _id: hq, name: "Delta HQ" },
  { _id: bangalore, name: "Delta Bangalore" },
]);

const customerIds: Record<string, Types.ObjectId> = {};
const customer = (organizationId: Types.ObjectId, email: string, extra: Record<string, unknown> = {}) => {
  const _id = new Types.ObjectId();
  customerIds[`${organizationId}:${email}`] = _id;
  return { _id, organizationId, email, name: email.split("@")[0], customerCode: `C-${_id}`, status: "active", ...extra };
};
await db.collection("customers").insertMany([
  customer(hq, "student.one@example.com"),
  customer(hq, "two.places@example.com"),
  customer(bangalore, "two.places@example.com"),
  customer(hq, "no.request@example.com"),
  customer(hq, "gone@example.com", { status: "archived" }),
  customer(hq, "many@example.com"),
  customer(hq, "only.manual@example.com"),
]);

let n = 0;
type Inv = {
  org?: Types.ObjectId; email: string; source?: string | null; crm?: string; course?: string; closedBy?: string;
  approval?: Record<string, unknown> | null; status?: string; day: string; enrolment?: boolean;
};
const invoice = (i: Inv) => {
  n++;
  const org = i.org ?? hq;
  const doc: Record<string, unknown> = {
    organizationId: org,
    invoiceNumber: `INV-${String(n).padStart(5, "0")}`,
    customerId: customerIds[`${org}:${i.email}`],
    customerName: i.email.split("@")[0],
    salespersonId: new Types.ObjectId(),
    salespersonName: "Finance Admin",
    status: i.status ?? "draft",
    issueDate: new Date(`${i.day}T00:00:00Z`),
    dueDate: new Date(`${i.day}T00:00:00Z`),
    currency: "AED",
    totalMinor: 100_00,
    createdAt: new Date(`${i.day}T10:00:00Z`),
    updatedAt: new Date(`${i.day}T10:00:00Z`),
  };
  if (i.enrolment !== false) {
    doc.enrolment = {
      course: i.course ?? "Forex Mastery",
      modeOfStudy: "online",
      language: "English",
      meetingBy: i.closedBy ?? "",
      ...(i.crm ? { crm: i.crm } : {}),
    };
  }
  if (i.source !== null) doc.external = { source: i.source ?? "crm", externalId: `ext-${n}`, flags: [] };
  if (i.approval !== null) doc.approval = i.approval ?? { state: "pending", submittedAt: new Date() };
  return doc;
};

await db.collection("invoices").insertMany([
  // student.one — three requests from three CRMs, oldest first here.
  invoice({ email: "student.one@example.com", day: "2026-10-01", source: "draw-crm", course: "Draw Basics", closedBy: "Karthika", approval: { state: "approved", at: new Date() } }),
  invoice({ email: "student.one@example.com", day: "2026-10-05", source: "crm", crm: "remote", course: "Forex Pro", closedBy: "Nusra", approval: { state: "returned", returnedReason: "Receipt is unreadable" } }),
  invoice({ email: "student.one@example.com", day: "2026-10-10", crm: "delta", course: "Forex Mastery", closedBy: "  Abrar  " }),
  // ...and what is not a request: typed in finance, voided, from Tetra Commission, no enrolment.
  invoice({ email: "student.one@example.com", day: "2026-10-11", source: null, course: "Typed here" }),
  invoice({ email: "student.one@example.com", day: "2026-10-12", course: "Voided", status: "void" }),
  invoice({ email: "student.one@example.com", day: "2026-10-12", source: "tetra-commission", course: "Upgrade" }),
  invoice({ email: "student.one@example.com", day: "2026-10-12", enrolment: false }),
  // two.places — one in each organization; the Bangalore one from the Banglore CRM, from before approvals.
  invoice({ email: "two.places@example.com", day: "2026-09-20", course: "Old Course", closedBy: "Maneesh", approval: null }),
  invoice({ org: bangalore, email: "two.places@example.com", day: "2026-10-09", source: "banglore-crm", course: "Bangalore Forex", closedBy: "Ravi" }),
  // gone — archived, but the request is still where it got to.
  invoice({ email: "gone@example.com", day: "2026-10-02", course: "Forex Mastery", approval: { state: "approved" } }),
  // only.manual — finance has invoices for them, none from a sales CRM.
  invoice({ email: "only.manual@example.com", day: "2026-10-03", source: null }),
  // many — twelve requests, one a day.
  ...Array.from({ length: 12 }, (_, k) => invoice({ email: "many@example.com", day: `2026-09-${String(k + 1).padStart(2, "0")}`, course: `Course ${k + 1}` })),
]);

step("A. Only the LMS gets an answer");
{
  const none = await ask({ emails: ["student.one@example.com"] }, null);
  check("no secret: 401", none.status === 401 && !("data" in (none.body ?? {})), j(none));
  const wrong = await ask({ emails: ["student.one@example.com"] }, "not-the-secret");
  check("a wrong secret: 401", wrong.status === 401 && !("data" in (wrong.body ?? {})), j(wrong));
  const short = await ask({ emails: ["student.one@example.com"] }, SECRET.slice(0, -1));
  check("the secret less a character: 401", short.status === 401, j(short));
}

step("B. Requests a sales CRM sent");
{
  const r = await ask({ emails: ["  Student.One@Example.COM "] });
  const s = r.body?.data?.results?.["student.one@example.com"];
  check("200, keyed by the email trimmed and lowercased", r.status === 200 && !!s, j(r));
  check("...in finance", s?.inFinance === true, j(s));
  check("...only its three CRM requests (typed, void, Tetra Commission and plain invoices left out)", s?.requests?.length === 3, j(s?.requests));
  const [newest, middle, oldest] = s?.requests ?? [];
  check("newest first", j((s?.requests ?? []).map((q: any) => q.course)) === j(["Forex Mastery", "Forex Pro", "Draw Basics"]), j(s?.requests));
  check("pending: crm delta, closed by Abrar (trimmed), the course", newest?.approval === "pending" && newest?.crm === "delta" && newest?.closedBy === "Abrar" && newest?.course === "Forex Mastery" && newest?.returnedReason === "", j(newest));
  check("returned, with its reason; crm as the CRM said (remote) over its source", middle?.approval === "returned" && middle?.returnedReason === "Receipt is unreadable" && middle?.crm === "remote" && middle?.closedBy === "Nusra", j(middle));
  check("approved; crm from the source (draw-crm → draw)", oldest?.approval === "approved" && oldest?.crm === "draw" && oldest?.returnedReason === "" && oldest?.closedBy === "Karthika", j(oldest));
  check("at: the issue date, ISO", newest?.at === "2026-10-10T00:00:00.000Z" && oldest?.at === "2026-10-01T00:00:00.000Z", j([newest?.at, oldest?.at]));
  check("invoice numbers", /^INV-\d{5}$/.test(newest?.invoiceNumber ?? "") && newest?.invoiceNumber !== oldest?.invoiceNumber, j(s?.requests));
  check("exactly the contract's fields", j(Object.keys(newest ?? {}).sort()) === j(["approval", "at", "closedBy", "course", "crm", "invoiceNumber", "returnedReason"]) && j(Object.keys(s ?? {}).sort()) === j(["inFinance", "requests"]), j(newest));

  const two = (await ask({ emails: ["two.places@example.com"] })).body?.data?.results?.["two.places@example.com"];
  check("in two organizations: both organizations' requests, newest first", j((two?.requests ?? []).map((q: any) => q.course)) === j(["Bangalore Forex", "Old Course"]), j(two));
  check("the Banglore CRM by its source (banglore-crm → banglore)", two?.requests?.[0]?.crm === "banglore" && two?.requests?.[0]?.closedBy === "Ravi", j(two?.requests?.[0]));
  check("from before approvals (no approval block): approved", two?.requests?.[1]?.approval === "approved" && two?.requests?.[1]?.crm === "delta", j(two?.requests?.[1]));
}

step("C/D. Emails with nothing to show, and ones that are not emails");
{
  const r = await ask({ emails: ["no.request@example.com", "never.seen@example.com", "gone@example.com", "only.manual@example.com", "not-an-email", 42, null, "", "NO.REQUEST@example.com"] });
  const res = r.body?.data?.results ?? {};
  check("200", r.status === 200, j(r));
  check("a key for every valid email, once each; none for the invalid ones", j(Object.keys(res).sort()) === j(["gone@example.com", "never.seen@example.com", "no.request@example.com", "only.manual@example.com"]), j(Object.keys(res)));
  check("in finance with no enrolment: inFinance, no requests", j(res["no.request@example.com"]) === j({ inFinance: true, requests: [] }), j(res["no.request@example.com"]));
  check("not in finance: a key all the same, nothing found", j(res["never.seen@example.com"]) === j({ inFinance: false, requests: [] }), j(res["never.seen@example.com"]));
  check("only invoices typed in finance: in finance, no requests", j(res["only.manual@example.com"]) === j({ inFinance: true, requests: [] }), j(res["only.manual@example.com"]));
  check("archived: not in finance, its request still shown", res["gone@example.com"]?.inFinance === false && res["gone@example.com"]?.requests?.length === 1 && res["gone@example.com"]?.requests?.[0]?.approval === "approved", j(res["gone@example.com"]));
  const allBad = await ask({ emails: ["not-an-email", 7] });
  check("only invalid emails: 200, no keys", allBad.status === 200 && j(allBad.body?.data) === j({ results: {} }), j(allBad));
}

step("E. The batch");
{
  const many = (await ask({ emails: ["many@example.com"] })).body?.data?.results?.["many@example.com"];
  check("twelve requests: the newest ten", many?.requests?.length === 10 && many.requests[0].course === "Course 12" && many.requests[9].course === "Course 3", j((many?.requests ?? []).map((q: any) => q.course)));
  const hundred = Array.from({ length: 99 }, (_, k) => `bulk${k}@example.com`).concat("student.one@example.com");
  const ok100 = await ask({ emails: hundred });
  check("100 emails: 200, 100 keys", ok100.status === 200 && Object.keys(ok100.body?.data?.results ?? {}).length === 100 && ok100.body?.data?.results?.["student.one@example.com"]?.requests?.length === 3, j(ok100).slice(0, 200));
  const over = await ask({ emails: [...hundred, "one.more@example.com"] });
  check("101 emails: 400 VALIDATION_ERROR", over.status === 400 && over.body?.error?.code === "VALIDATION_ERROR", j(over));
  for (const body of [{}, { emails: [] }, { emails: "student.one@example.com" }, { emails: { 0: "student.one@example.com" } }]) {
    const r = await ask(body);
    check(`${j(body)}: 400 VALIDATION_ERROR`, r.status === 400 && r.body?.error?.code === "VALIDATION_ERROR", j(r));
  }
}

await mongoose.disconnect();
console.log("");
if (fail) { console.log(`\x1b[31m${fail} of ${pass + fail} checks failed\x1b[0m`); process.exit(1); }
console.log(`\x1b[32mAll ${pass} checks passed\x1b[0m`);
