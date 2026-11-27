/**
 * Course changes from the sales CRMs (the user, 2026-11-23), over real HTTP
 * against a real API process:
 *
 *   A. Intake (signed, as a CRM sends it): an enrolment finance never had, or
 *      another CRM's, not found; not approved, void, a fee below what is paid,
 *      nothing changing (case and spaces aside) refused; the same id twice is
 *      the same request; a second one for the same invoice — even at the same
 *      moment — refused while one waits; the approvers are emailed.
 *   B. Approved on the Approvals page: the invoice line becomes the new course
 *      at the new fee (its item, VAT inside, approval kept), the balance and
 *      status follow; the enrolment says the new course and its LMS courses;
 *      the LMS course it adds is queued; decided once only. A cheaper course
 *      down to what is paid: paid in full, the LMS told to open everything.
 *      One that no longer fits is refused, still waiting; a claim in progress
 *      cannot be decided by somebody else.
 *   C. Rejected with a reason (too short refused); nothing changes.
 *   D. The enrolment's status answers the CRM: each course change with where it
 *      stands, oldest first, and the course and total as they are now.
 *   E. The Approvals page: the kind in the summary and the list, searchable,
 *      raised by the salesperson; a salesperson here cannot read or decide one.
 *
 * Run through scripts/course-change-e2e.sh. Scratch database only.
 */
import crypto from "node:crypto";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri) || !/e2e/i.test(uri) || /:27017\//.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1 (not 27017), got "${uri}"`);
  process.exit(1);
}

const { hashPassword } = await import("../lib/password");
const { Organization } = await import("../modules/organization/organization.model");
const { Role } = await import("../modules/role/role.model");
const { User } = await import("../modules/user/user.model");
const { Invoice } = await import("../modules/invoice/invoice.model");
const { Item } = await import("../modules/inventory/item.model");
const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
const { CourseChangeModel } = await import("../modules/course-change/course-change.model");

const ORIGIN = `http://127.0.0.1:${process.env.E2E_API_PORT}`;
const BASE = `${ORIGIN}/api/v1`;
const INBOUND_ID = process.env.INBOUND_CLIENT_ID ?? "";
const INBOUND_SECRET = process.env.INBOUND_INTEGRATION_SECRET ?? "";
const PASSWORD = "E2ePassword1!";

/** Approving a close sends each collected payment's reference (2026-11-18): a fresh one for each, the extra ones unused. */
const approveRefs = () => ({ references: Array.from({ length: 10 }, () => `REF-${crypto.randomUUID().slice(0, 13)}`) });
let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(s: string) { console.log(`\n\x1b[1m${s}\x1b[0m`); }

const DAY = 86_400_000;
const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const dayOf = (offset: number) => new Date(today.getTime() + offset * DAY).toISOString().slice(0, 10);
const vat = (gross: number) => Math.round((gross * 5) / 105);

type Res = { status: number; body: Record<string, any> };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 300)}`;
async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}
async function signedPost(orgId: string, p: string, payload: unknown): Promise<Res> {
  const raw = JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const canonical = ["POST", p, ts, nonce, crypto.createHash("sha256").update(raw).digest("hex")].join("\n");
  const r = await fetch(`${ORIGIN}${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-delta-client": INBOUND_ID, "x-delta-timestamp": ts, "x-delta-nonce": nonce,
      "x-delta-signature": crypto.createHmac("sha256", INBOUND_SECRET).update(canonical).digest("hex"), "x-delta-org": orgId,
    },
    body: raw,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
}
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await mongoose.connect(uri);
  if (mongoose.connection.host !== "127.0.0.1") throw new Error("not 127.0.0.1");
  await mongoose.connection.dropDatabase();

  step("Setting up");
  const org = await Organization.create({ name: "Delta HQ E2E", baseCurrency: "AED", email: "accounts@e2e-test.com", phone: "+971 4 000 0000", taxRates: [{ label: "VAT 5%", code: "VAT", rate: 5, isDefault: true, appliesTo: "sales" }] });
  for (const def of SYSTEM_ROLES) {
    await Role.create({ organizationId: org._id, key: def.key, name: def.name, description: def.description, permissions: def.permissions, isSystem: true });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const roleId = (key: string) => new Types.ObjectId(String(roles.find((r) => r.key === key)!._id));
  const passwordHash = await hashPassword(PASSWORD);
  await User.create({ name: "Accounts Admin", email: "accounts.admin@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId("admin"), status: "active" }] });
  await User.create({ name: "Sally Sales", email: "sally@e2e-test.com", passwordHash, status: "active", memberships: [{ organizationId: org._id, roleId: roleId("salesperson"), status: "active" }] });
  const token = (await request("POST", "/auth/login", { email: "accounts.admin@e2e-test.com", password: PASSWORD })).body?.data?.accessToken as string;
  const sallyToken = (await request("POST", "/auth/login", { email: "sally@e2e-test.com", password: PASSWORD })).body?.data?.accessToken as string;
  check("an accountant and a salesperson can sign in", Boolean(token && sallyToken));
  const HQ = String(org._id);
  const MBT = "market-breakout-e2e", DWT = "wave-theory-e2e", ALT = "alt-course-e2e";
  // Straight into the collection, as the enrolment-change check does: the catalogue's own rules are not what is tested.
  const one = { _id: new Types.ObjectId() }, bundle = { _id: new Types.ObjectId() };
  await Item.collection.insertMany([
    { _id: one._id, organizationId: org._id, itemNumber: "ITM-00001", name: "Market Breakout", sku: "MB-1", type: "service", unitPriceMinor: 550_000, lmsCourseSlug: MBT, lmsCourseSlugs: [MBT], isActive: true },
    { _id: bundle._id, organizationId: org._id, itemNumber: "ITM-00002", name: "Market Breakout + Wave Theory", sku: "MB-2", type: "service", unitPriceMinor: 800_000, lmsCourseSlug: MBT, lmsCourseSlugs: [MBT, DWT], isActive: true },
  ]);
  const BUNDLE = "Market Breakout + Wave Theory";

  let n = 0;
  /** A CRM close of Market Breakout: `paid` declared as one payment; approved unless told not to; with its LMS record. */
  async function close(opts: { fee?: number; paid?: number; approve?: boolean; source?: string } = {}) {
    n++;
    const fee = opts.fee ?? 550_000;
    const paid = opts.paid ?? 200_000;
    const externalId = `close-${n}`;
    const r = await signedPost(HQ, "/api/v1/integrations/enrolments", {
      externalId, source: opts.source ?? "crm", crm: "delta",
      customer: { name: `Client ${n}`, email: `client${n}@e2e-test.com`, phone: `+97150000${String(n).padStart(4, "0")}` },
      course: { name: "Market Breakout", itemId: String(one._id), amountMinor: fee, lmsCourseSlug: MBT },
      modeOfStudy: "online", language: "English", salespersonEmail: "sally@e2e-test.com", salespersonName: "Sally Sales",
      enrolledOn: dayOf(-10),
      declaredPaidMinor: paid,
      ...(paid > 0 ? { declaredPaymentMethod: "cash", payments: [{ method: "cash", amountMinor: paid, paidOn: dayOf(-9) }] } : {}),
    });
    const id = String(r.body?.data?.invoiceId ?? "");
    if (!id) throw new Error(`enrolment refused: ${show(r)}`);
    if (opts.approve !== false) {
      const a = await request("POST", `/invoices/${id}/approval/approve`, approveRefs(), token);
      if (a.status !== 200) throw new Error(`approval refused: ${show(a)}`);
      // The LMS has the student on the first course (no LMS here, so its record is made as the worker leaves it).
      await LmsProvision.create({ organizationId: org._id, invoiceId: new Types.ObjectId(id), invoiceNumber: "", payload: { email: `client${n}@e2e-test.com`, courseSlug: MBT, paymentStatus: paid >= fee ? "paid" : "partial" }, status: "sent", source: "crm", access: { sent: paid >= fee ? "paid" : "partial" } });
    }
    return { id, externalId };
  }
  const inv = async (id: string) => (await Invoice.findById(id).lean()) as any;
  let m = 0;
  const ask = (enrolmentExternalId: string, extra: Record<string, unknown> = {}) =>
    signedPost(HQ, "/api/v1/integrations/enrolments/course-changes", {
      source: "crm", enrolmentExternalId, externalId: `cc-${++m}`,
      course: { name: BUNDLE, itemId: String(bundle._id), lmsCourseSlug: MBT, lmsCourseSlugs: [MBT, DWT] },
      priceMinor: 800_000, reason: "Upgraded to the bundle on the call", requestedBy: { name: "Sally Sales", email: "sally@e2e-test.com" }, ...extra,
    });
  const statusOf = async (externalId: string, source = "crm") =>
    (await signedPost(HQ, "/api/v1/integrations/enrolments/status", { source, externalIds: [externalId] })).body?.data?.[0];
  const decide = (id: string, body: unknown, t = token) => request("POST", `/course-changes/${id}/decision`, body, t);

  /* ── A ── */
  step("A. Intake");
  const a = await close();
  let r = await ask("nobody-sent-this");
  check("an enrolment finance never had: not found", r.status === 404 && /not in finance/.test(r.body?.error?.message ?? ""), show(r));
  r = await ask(a.externalId, { source: "draw-crm" });
  check("another CRM cannot change this CRM's enrolment", r.status === 404, show(r));
  const unapproved = await close({ approve: false });
  r = await ask(unapproved.externalId);
  check("not approved yet: refused, pointing at the CRM", r.status === 409 && /not approved yet — correct it in the CRM/.test(r.body?.error?.message ?? ""), show(r));
  const voided = await close();
  await Invoice.updateOne({ _id: voided.id }, { $set: { status: "void" } });
  r = await ask(voided.externalId);
  check("void: refused", r.status === 409 && /void/.test(r.body?.error?.message ?? ""), show(r));
  r = await ask(a.externalId, { priceMinor: 150_000 });
  check("a fee below what is paid: refused, saying how much is paid", r.status === 409 && r.body?.error?.message === "AED 2,000.00 is already paid — the new fee can't be less", show(r));
  r = await ask(a.externalId, { course: { name: "  market   BREAKOUT " }, priceMinor: 550_000 });
  check("the same course (case and spaces aside) at the same fee: nothing changes, refused", r.status === 409 && /Nothing changes/.test(r.body?.error?.message ?? ""), show(r));
  r = await ask(a.externalId, { reason: "no" });
  check("a reason under 3 characters: refused", r.status === 422, show(r));
  r = await ask(a.externalId, { priceMinor: 0 });
  check("a fee of nothing: refused", r.status === 422, show(r));
  r = await ask(a.externalId, { course: { itemId: String(bundle._id) } });
  check("no course name: refused", r.status === 422, show(r));
  check("nothing stored for any of them", (await CourseChangeModel.countDocuments()) === 0);

  r = await ask(a.externalId);
  const c1 = r.body?.data;
  const c1Ext = `cc-${m}`;
  check("received: pending, from the invoice's course and total to the new course and fee, why, who asked", r.status < 300 && c1?.status === "pending"
    && c1?.invoiceId === a.id && c1?.customerName === "Client 1" && /^IN-/.test(c1?.invoiceNumber ?? "")
    && c1?.fromCourse === "Market Breakout" && c1?.fromPriceMinor === 550_000
    && c1?.course?.name === BUNDLE && c1?.course?.itemId === String(bundle._id) && JSON.stringify(c1?.course?.lmsCourseSlugs) === JSON.stringify([MBT, DWT])
    && c1?.priceMinor === 800_000 && c1?.currency === "AED" && c1?.reason === "Upgraded to the bundle on the call"
    && c1?.requestedBy?.name === "Sally Sales" && !c1?.decision, show(r));
  const again = await signedPost(HQ, "/api/v1/integrations/enrolments/course-changes", {
    source: "crm", enrolmentExternalId: a.externalId, externalId: c1Ext, course: { name: "Something else" }, priceMinor: 600_000,
    reason: "A retry after a timeout", requestedBy: { name: "Sally Sales", email: "" },
  });
  check("the same id again: the same request, not a second", again.status === 200 && again.body?.data?.id === c1?.id && again.body?.data?.priceMinor === 800_000
    && (await CourseChangeModel.countDocuments()) === 1, show(again));
  r = await ask(a.externalId, { priceMinor: 700_000 });
  check("another one for the same invoice while one waits: refused, saying so", r.status === 409 && /already waiting for finance/.test(r.body?.error?.message ?? ""), show(r));
  const race = await close();
  const both = await Promise.all([ask(race.externalId), ask(race.externalId, { priceMinor: 900_000 })]);
  check("two for the same invoice at the same moment: one in, the other refused", both.filter((x) => x.status === 200).length === 1
    && both.filter((x) => x.status === 409).length === 1 && (await CourseChangeModel.countDocuments({ invoiceId: race.id })) === 1, both.map(show).join(" | "));
  await settle();
  const mail = await mongoose.connection.db!.collection("emaillogs").findOne({ kind: "course_change_notice" });
  check("the approvers are told one is waiting", !!mail && /Course change to approve: Client 1/.test(mail.subject ?? "") && JSON.stringify(mail.to).includes("accounts.admin@e2e-test.com"), JSON.stringify(mail));

  /* ── B ── */
  step("B. Approved");
  r = await decide(c1.id, { decision: "approved" }, sallyToken);
  check("a salesperson here cannot decide it", r.status === 403, show(r));
  r = await request("GET", `/course-changes/${c1.id}`, undefined, token);
  check("the accountant reads it with what is paid and what would be left", r.status === 200 && r.body?.data?.invoice?.paidMinor === 200_000
    && r.body?.data?.invoice?.balanceMinor === 350_000 && r.body?.data?.invoice?.balanceAfterMinor === 600_000, show(r));
  const before = await inv(a.id);
  r = await decide(c1.id, { decision: "approved", note: "Checked with the client" });
  const approved = r.body?.data;
  check("approved: who approved it, the note", r.status === 200 && approved?.status === "approved" && approved?.decision?.decidedByName === "Accounts Admin"
    && approved?.decision?.note === "Checked with the client", show(r));
  let d = await inv(a.id);
  check("the line is the new course at 8,000, its item, VAT inside", d.lineItems.length === 1 && d.lineItems[0].description === BUNDLE
    && String(d.lineItems[0].itemId) === String(bundle._id) && d.lineItems[0].unitPriceMinor === 800_000 && d.totalMinor === 800_000
    && Math.abs(d.taxTotalMinor - vat(800_000)) <= 1 && d.lineItems[0].taxes?.[0]?.code === "VAT", JSON.stringify({ l: d.lineItems, t: d.totalMinor, x: d.taxTotalMinor }));
  check("the balance and status follow; the approval and the payment stay", d.amountPaidMinor === 200_000 && d.balanceMinor === 600_000 && d.status === "partial"
    && d.approval?.state === "approved" && d.payments.length === before.payments.length && d.invoiceNumber === before.invoiceNumber,
    JSON.stringify({ p: d.amountPaidMinor, b: d.balanceMinor, s: d.status, a: d.approval?.state }));
  // 2026-11-27: the stored total in the organization's currency (what the Revenue report reads) follows the new fee.
  check("the stored total in AED follows: 8,000, not the 5,500 it was made at", before.baseTotalMinor === 550_000 && d.baseTotalMinor === 800_000,
    JSON.stringify({ before: before.baseTotalMinor, after: d.baseTotalMinor }));
  check("the enrolment says the new course and both its LMS courses", d.enrolment.course === BUNDLE
    && JSON.stringify(d.enrolment.courses) === JSON.stringify([{ name: BUNDLE, lmsCourseSlugs: [MBT, DWT] }]) && d.enrolment.lmsCourseSlug === MBT
    && d.enrolment.modeOfStudy === "online", JSON.stringify(d.enrolment));
  let lp: any = await LmsProvision.findOne({ invoiceId: a.id }).lean();
  check("the LMS course it adds is queued to open; the one it has is not sent again", lp?.extraCourses?.length === 1 && lp.extraCourses[0].slug === DWT
    && lp.extraCourses[0].status === "pending" && lp.payload?.courseSlug === MBT, JSON.stringify(lp?.extraCourses));
  r = await decide(c1.id, { decision: "approved" });
  check("decided once: a second approval is refused", r.status === 409 && /already approved/.test(r.body?.error?.message ?? ""), show(r));
  r = await decide(c1.id, { decision: "rejected", reason: "Changed my mind" });
  check("…and so is rejecting it after", r.status === 409, show(r));
  r = await signedPost(HQ, "/api/v1/integrations/enrolments/course-changes", {
    source: "crm", enrolmentExternalId: a.externalId, externalId: c1Ext, course: { name: BUNDLE }, priceMinor: 800_000, reason: "A late retry", requestedBy: { name: "", email: "" },
  });
  check("its id again after the decision: the same request, approved, nothing applied twice", r.body?.data?.id === c1.id && r.body?.data?.status === "approved"
    && (await inv(a.id)).lineItems.length === 1, show(r));

  // Down to a cheaper course, with no catalogue item this organization has: a plain line, the LMS courses the CRM sent.
  const b = await close({ fee: 550_000, paid: 300_000 });
  r = await ask(b.externalId, { course: { name: "Alt Course", itemId: String(new Types.ObjectId()), lmsCourseSlug: ALT }, priceMinor: 300_000 });
  const c2 = r.body?.data;
  r = await decide(c2.id, { decision: "approved" });
  d = await inv(b.id);
  await settle(500);
  lp = await LmsProvision.findOne({ invoiceId: b.id }).lean();
  check("a cheaper course down to what is paid: a plain line at 3,000, paid in full", r.status === 200 && d.lineItems[0].description === "Alt Course" && !d.lineItems[0].itemId
    && d.totalMinor === 300_000 && d.balanceMinor === 0 && d.status === "paid", JSON.stringify({ r: show(r), l: d.lineItems[0], s: d.status }));
  check("…its stored total in AED down to 3,000 as well", d.baseTotalMinor === 300_000, String(d.baseTotalMinor));
  check("…the enrolment on the CRM's LMS course, that course queued, the LMS told it is paid", d.enrolment.course === "Alt Course"
    && JSON.stringify(d.enrolment.courses) === JSON.stringify([{ name: "Alt Course", lmsCourseSlugs: [ALT] }]) && d.enrolment.lmsCourseSlug === ALT
    && lp?.extraCourses?.length === 1 && lp.extraCourses[0].slug === ALT && lp?.access?.pending === "paid", JSON.stringify({ e: d.enrolment.courses, lp: { x: lp?.extraCourses, a: lp?.access } }));

  // Waiting while accounts record more than its fee: it no longer fits.
  const late = await close({ fee: 550_000, paid: 100_000 });
  r = await ask(late.externalId, { course: { name: "Alt Course" }, priceMinor: 200_000 });
  const c3 = r.body?.data;
  await request("POST", `/invoices/${late.id}/payments`, { method: "cash", amountMinor: 150_000, paidOn: dayOf(0) }, token);
  r = await decide(c3.id, { decision: "approved" });
  const c3Row: any = await CourseChangeModel.findById(c3.id).lean();
  d = await inv(late.id);
  check("no longer fits (now AED 2,500 paid): not changed, still waiting, for a person to reject", r.status === 409
    && /^Not changed: AED 2,500\.00 is already paid/.test(r.body?.error?.message ?? "") && c3Row?.status === "pending" && !c3Row?.decision
    && d.lineItems[0].description === "Market Breakout" && d.totalMinor === 550_000, show(r));
  // Somebody else is approving it right now.
  await CourseChangeModel.updateOne({ _id: c3.id }, { $set: { decision: { decidedByName: "Someone", decidedAt: new Date() } } });
  r = await decide(c3.id, { decision: "rejected", reason: "Too late for this one" });
  check("while somebody else is approving it: refused", r.status === 409 && /deciding it just now/.test(r.body?.error?.message ?? ""), show(r));
  r = await request("GET", `/course-changes/${c3.id}`, undefined, token);
  check("…and it still reads as waiting, with no decision", r.body?.data?.status === "pending" && !r.body?.data?.decision, show(r));
  await CourseChangeModel.updateOne({ _id: c3.id }, { $unset: { decision: "" } });

  /* ── C ── */
  step("C. Rejected");
  r = await decide(c3.id, { decision: "rejected", reason: "no" });
  check("a reason under 5 characters: refused", r.status === 422, show(r));
  r = await decide(c3.id, { decision: "rejected", reason: "The client paid more meanwhile; ask again" });
  d = await inv(late.id);
  check("rejected with why; the invoice and enrolment as they were", r.status === 200 && r.body?.data?.status === "rejected"
    && r.body?.data?.decision?.reason === "The client paid more meanwhile; ask again" && d.enrolment.course === "Market Breakout" && d.totalMinor === 550_000, show(r));
  r = await decide(c3.id, { decision: "approved" });
  check("…and cannot be approved after", r.status === 409, show(r));
  r = await ask(late.externalId, { course: { name: "Alt Course" }, priceMinor: 400_000 });
  check("rejected, another may be asked for", r.status === 200 && r.body?.data?.status === "pending", show(r));
  const c4 = r.body?.data;

  /* ── D ── */
  step("D. The status the CRM reads");
  let s = await statusOf(a.externalId);
  check("the enrolment's course and total as they are now", s?.course === BUNDLE && s?.totalMinor === 800_000 && s?.balanceMinor === 600_000, JSON.stringify(s).slice(0, 300));
  check("its course change, approved, with who, when and the note", s?.courseChanges?.length === 1 && s.courseChanges[0].externalId === c1Ext
    && s.courseChanges[0].status === "approved" && s.courseChanges[0].course === BUNDLE && s.courseChanges[0].priceMinor === 800_000 && s.courseChanges[0].currency === "AED"
    && s.courseChanges[0].decidedBy === "Accounts Admin" && !!s.courseChanges[0].decidedAt && s.courseChanges[0].note === "Checked with the client" && !s.courseChanges[0].reason,
    JSON.stringify(s?.courseChanges));
  s = await statusOf(late.externalId);
  const cc = s?.courseChanges ?? [];
  check("oldest first: the rejected one with why, then the one waiting with no decision", cc.length === 2
    && cc[0].status === "rejected" && cc[0].reason === "The client paid more meanwhile; ask again" && cc[0].decidedBy === "Accounts Admin" && cc[0].priceMinor === 200_000
    && cc[1].status === "pending" && cc[1].externalId === `cc-${m}` && !cc[1].decidedAt && !cc[1].decidedBy && cc[1].course === "Alt Course", JSON.stringify(cc));
  s = await statusOf(voided.externalId);
  check("none asked for: an empty list", Array.isArray(s?.courseChanges) && s.courseChanges.length === 0, JSON.stringify(s).slice(0, 200));

  /* ── E ── */
  step("E. The Approvals page");
  await settle();
  r = await request("GET", "/approvals/summary", undefined, token);
  const group = (r.body?.data?.groups ?? []).find((g: any) => g.type === "course_change");
  check("in the summary: the two waiting (this one and the race's)", group?.count === 2 && group?.label === "Course changes", show(r));
  r = await request("GET", "/approvals/list?type=course_change&status=pending", undefined, token);
  const row = (r.body?.data ?? []).find((x: any) => x.id === c4.id);
  check("in the list: the client, from → to, the new fee, decided here, raised by the salesperson", r.body?.data?.length === 2 && row?.title === `Client ${n}`
    && row?.subtitle?.includes("Market Breakout → Alt Course") && row?.amountMinor === 400_000 && row?.decideHere === true && row?.raisedBy === "Sally Sales", show(r));
  r = await request("GET", "/approvals/list?type=course_change&status=all", undefined, token);
  check("all five, with their states", r.body?.data?.length === 5 && new Set(r.body.data.map((x: any) => x.status)).size === 3, show(r));
  r = await request("GET", "/approvals/list?type=course_change&status=rejected", undefined, token);
  check("the rejected one says why", r.body?.data?.length === 1 && r.body.data[0].reason === "The client paid more meanwhile; ask again", show(r));
  r = await request("GET", `/approvals/list?status=all&q=${encodeURIComponent("Wave Theory")}`, undefined, token);
  check("searchable by the course", (r.body?.data ?? []).some((x: any) => x.type === "course_change" && x.id === c1.id), show(r));
  r = await request("GET", "/approvals/raisers", undefined, token);
  check("Sally among who raised them", (r.body?.data ?? []).includes("Sally Sales"), show(r));
  r = await request("GET", "/approvals/list?type=course_change&status=all", undefined, sallyToken);
  check("a salesperson here sees none", (r.body?.data ?? []).length === 0, show(r));
  r = await request("GET", `/course-changes/${c4.id}`, undefined, sallyToken);
  check("…nor reads one", r.status === 403, show(r));

  console.log(`\n${checks - failures}/${checks} checks passed`);
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
