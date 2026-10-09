/**
 * Drives an approved enrolment into the LMS, over real HTTP against a real
 * LMS process and a real finance process.
 *
 * The chain has three places it can quietly do the wrong thing, and this is
 * about those rather than the happy path:
 *
 *   1. It must fire for an enrolment the sales CRM raised, and for nothing
 *      else. An invoice accounts typed here is a billing document; giving a
 *      student course access because a bookkeeper raised one would be a
 *      surprise of the worst kind.
 *   2. It must identify the course by the mapped slug, never by the name. This
 *      database holds nine spellings of three courses, and enrolling somebody
 *      on the wrong one is worse than not enrolling them.
 *   3. It must provision once. Finance queues and retries, so the same
 *      approval arrives repeatedly; twice would report the sale twice.
 *
 * Run through scripts/lms-provision-e2e.sh. Scratch databases only — one for
 * finance, one for the LMS.
 */
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}
const lmsUri = process.env.LMS_MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(lmsUri) || !/e2e|test/i.test(lmsUri)) {
  console.error(`Refusing to run: LMS_MONGODB_URI must be a scratch database, got "${lmsUri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4117";
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const PASSWORD = "E2ePassword1!";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
function step(n: string) { console.log(`\n\x1b[1m${n}\x1b[0m`); }

type Res = { status: number; body: Record<string, never> };
async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, never> };
}
const post = (p: string, b?: unknown, t?: string) => request("POST", p, b, t);

/** Queueing is deliberately unawaited by the approval, so give it a moment. */
const settle = () => new Promise((r) => setTimeout(r, 700));

/** The LMS database, opened alongside finance's so both ends can be read. */
async function lmsDb() {
  const c = await mongoose.createConnection(lmsUri).asPromise();
  return c;
}

async function main() {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();
  const lms = await lmsDb();
  await lms.dropDatabase();

  step("Setting up both systems");
  // An LMS course with a slug, and the organization that runs it.
  const lmsOrg = await lms.db!.collection("organizations").insertOne({
    name: "Delta Dubai", slug: "dubai", currency: "AED", createdAt: new Date(), updatedAt: new Date(),
  });
  await lms.db!.collection("courses").insertOne({
    title: "MARKET BREAK-OUT TRADING PROGRAM",
    slug: "market-break-out-trading-program",
    program: "4x-trading",
    organizationId: lmsOrg.insertedId,
    price: 1300, isPublished: true, createdAt: new Date(), updatedAt: new Date(),
  });
  check("the LMS has a course with a slug", true);

  const org = await Organization.create({ name: "Delta HQ", baseCurrency: "AED" });
  for (const def of SYSTEM_ROLES) {
    await Role.create({
      organizationId: org._id, key: def.key, name: def.name,
      description: def.description, permissions: def.permissions, isSystem: true,
    });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const adminRoleId = String(roles.find((r) => r.key === "admin")!._id);
  await User.create({
    name: "Org Admin", email: "admin@e2e-test.com",
    passwordHash: await hashPassword(PASSWORD), status: "active",
    memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(adminRoleId), status: "active" }],
  });

  // The finance item, mapped to that slug. This mapping is the whole point.
  const { Item } = await import("../modules/inventory/item.model");
  const mapped = await Item.create({
    organizationId: org._id, itemNumber: "ITM-0001", name: "Market Break out", sku: "MBT",
    type: "service", trackStock: false, sellingPriceMinor: 130_000,
    lmsCourseSlug: "market-break-out-trading-program",
  });
  const unmapped = await Item.create({
    organizationId: org._id, itemNumber: "ITM-0002", name: "Delta Wave Theory", sku: "DWT",
    type: "service", trackStock: false, sellingPriceMinor: 100_000,
  });
  check("a finance item is mapped to it", Boolean(mapped.lmsCourseSlug));

  const login = await post("/auth/login", { email: "admin@e2e-test.com", password: PASSWORD });
  const token = (login.body?.data as unknown as { accessToken?: string } | undefined)?.accessToken;
  if (!token) throw new Error(`login failed: ${JSON.stringify(login.body).slice(0, 200)}`);

  const today = new Date().toISOString().slice(0, 10);
  const orgId = String(org._id);

  /** An enrolment arriving from the CRM, as the intake receives one. */
  async function crmEnrolment(externalId: string, itemId: string, email: string, name: string) {
    const { intakeEnrolment } = await import("../modules/integrations/enrolment-intake.service");
    return intakeEnrolment(orgId, {
      externalId, source: "crm",
      customer: { name, email, phone: "+971500000000" },
      course: { name: "Market Break out", itemId, amountMinor: 130_000 },
      enrolledOn: today, declaredPaidMinor: 0,
      modeOfStudy: "online", language: "English",
    } as never);
  }

  const { LmsProvision } = await import("../modules/integrations/lms-provision.model");
  const { drainLmsProvisions } = await import("../jobs/lms-provision.worker");

  // ── The sale the CRM closed ───────────────────────────────────────────────
  step("Provisioning an enrolment the sales team closed");
  {
    const inv = await crmEnrolment("crm-1", String(mapped._id), "student@e2e-test.com", "Alia Rahman");
    const r = await post(`/invoices/${inv.invoiceId}/approval/approve`, undefined, token);
    check("the approver approves it", r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    await settle();

    // Queued, not sent inline: approving must not wait on another system.
    const queued = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(inv.invoiceId) }).lean();
    check("...and it is queued for the LMS", queued?.status === "pending", `status=${queued?.status}`);
    check("...with the mapped slug, not the typed name",
      (queued?.payload as { courseSlug?: string })?.courseSlug === "market-break-out-trading-program",
      `slug=${(queued?.payload as { courseSlug?: string })?.courseSlug}`);

    const sent = await drainLmsProvisions();
    check("the worker delivers it", sent === 1, `${sent} delivered`);

    const row = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(inv.invoiceId) }).lean();
    check("...and records what the LMS made of it", row?.status === "sent", `status=${row?.status} err=${row?.lastError}`);
    check("...naming the student it created", Boolean(row?.lmsUserId), "no lmsUserId");
    // What decides whether the student goes on to Tetra Commission: Forex students only.
    check("...and the course's programme, as the LMS names it", row?.lmsCourseProgram === "4x-trading", `program=${row?.lmsCourseProgram}`);

    // The far side: a real student, really enrolled.
    const user = await lms.db!.collection("users").findOne({ email: "student@e2e-test.com" });
    check("the LMS has the student", Boolean(user), "no user");
    check("...as an approved student", user?.role === "student" && user?.enrollmentStatus === "approved",
      `role=${user?.role} status=${user?.enrollmentStatus}`);
    check("...under the academy that runs the course", String(user?.organizationId) === String(lmsOrg.insertedId));
    const enrolment = await lms.db!.collection("enrollments").findOne({ userId: user!._id });
    check("...and is enrolled on it", Boolean(enrolment), "no enrollment");
    const order = await lms.db!.collection("orders").findOne({ "externalRef.id": inv.invoiceId });
    check("...with the sale recorded against the invoice", Boolean(order), "no order carrying the invoice id");
    // The fix: an order holds the smallest unit, like the gateways' do. AED
    // 1,300 was stored as 1300 and shown as AED 13.00.
    check("...in minor units, the way every other order is kept", order?.amount === 130_000 && order?.currency === "aed",
      `amount=${order?.amount} currency=${order?.currency}`);
    check("...and marked so, which is what keeps the one-off correction off it", order?.externalRef?.minorUnits === true,
      JSON.stringify(order?.externalRef));
  }

  // ── What the enrolment cost, as finance approved it ──────────────────────
  step("The fee, the payment, the balance, the bonus and the receipt reach the LMS");
  {
    const { intakeEnrolment } = await import("../modules/integrations/enrolment-intake.service");
    const inv = await intakeEnrolment(orgId, {
      externalId: "crm-fees", source: "crm",
      customer: { name: "Fees Student", email: "fees@e2e-test.com", phone: "+971500000001" },
      course: { name: "Market Break out", itemId: String(mapped._id), amountMinor: 130_000 },
      enrolledOn: today, declaredPaidMinor: 50_000, declaredPaymentMethod: "cash",
      modeOfStudy: "online", language: "English",
      balanceMinor: 80_000, bonus: { given: true, amountMinor: 25_000 },
      receipt: { name: "receipt.jpg", url: "https://files.example.com/enrolment-receipts/lead-9/1-receipt.jpg", key: "enrolment-receipts/lead-9/1-receipt.jpg", mimeType: "image/jpeg" },
    } as never);
    await post(`/invoices/${inv.invoiceId}/approval/approve`, undefined, token);
    await settle();
    await drainLmsProvisions();
    const user = await lms.db!.collection("users").findOne({ email: "fees@e2e-test.com" });
    const enrolment = user ? await lms.db!.collection("enrollments").findOne({ userId: user._id }) : null;
    const fees = enrolment?.feeSummary as Record<string, any> | undefined;
    check("Case 1 — the enrolment carries the fee, what was paid and the balance",
      fees?.feeMinor === 130_000 && fees?.paidMinor === 50_000 && fees?.balanceMinor === 80_000 && fees?.currency === "AED",
      JSON.stringify(fees));
    check("...the bonus beside them, not in them", fees?.bonus?.given === true && fees?.bonus?.amountMinor === 25_000, JSON.stringify(fees?.bonus));
    check("...the receipt the counsellor took", fees?.receipt?.url === "https://files.example.com/enrolment-receipts/lead-9/1-receipt.jpg",
      JSON.stringify(fees?.receipt));
    check("...and the invoice it came from", fees?.invoiceId === inv.invoiceId && fees?.invoiceNumber === inv.invoiceNumber,
      `${fees?.invoiceId} ${fees?.invoiceNumber}`);
    check("Case 2 — a bonus never lowers the balance: fee − paid, whatever the bonus", fees?.balanceMinor === 130_000 - 50_000);

    // Arriving again — finance retrying — records nothing new and changes nothing.
    await LmsProvision.updateOne({ invoiceId: new Types.ObjectId(inv.invoiceId) }, { $set: { status: "pending", nextAttemptAt: new Date(0) } });
    await drainLmsProvisions();
    const again = await lms.db!.collection("enrollments").findOne({ userId: user!._id });
    check("Case 2 — a repeat arrival leaves the summary as first recorded",
      String((again?.feeSummary as { recordedAt?: Date })?.recordedAt) === String(fees?.recordedAt));
  }

  // ── The retry ─────────────────────────────────────────────────────────────
  step("Arriving twice");
  {
    const inv = await crmEnrolment("crm-2", String(mapped._id), "twice@e2e-test.com", "Repeat Student");
    await post(`/invoices/${inv.invoiceId}/approval/approve`, undefined, token);
    await settle();
    await drainLmsProvisions();

    // Force it back into the queue, as a failed delivery would leave it.
    await LmsProvision.updateOne(
      { invoiceId: new Types.ObjectId(inv.invoiceId) },
      { $set: { status: "pending", nextAttemptAt: new Date() } },
    );
    await drainLmsProvisions();

    const orders = await lms.db!.collection("orders").countDocuments({ "externalRef.id": inv.invoiceId });
    check("the same approval provisions once", orders === 1, `${orders} orders`);
    const users = await lms.db!.collection("users").countDocuments({ email: "twice@e2e-test.com" });
    check("...and makes one student", users === 1, `${users} users`);
  }

  // ── What must not reach the LMS ───────────────────────────────────────────
  step("Leaving everything else alone");
  {
    // An invoice accounts raised here. It has no CRM origin, so whatever else
    // is true of it, it is not a course sale.
    const { createInvoice } = await import("../modules/invoice/invoice.service");
    const { Customer } = await import("../modules/customer/customer.model");
    const c = await Customer.create({
      organizationId: org._id, customerCode: "CUS-09", name: "Direct Client",
      email: "direct@e2e-test.com", phone: "+971500000009", currency: "AED", status: "active",
    });
    const own = await createInvoice(orgId, {
      customerId: String(c._id), salespersonId: String((await User.findOne({ email: "admin@e2e-test.com" }))!._id),
      issueDate: today, dueDate: today, currency: "AED",
      lineItems: [{ description: "Consulting", quantity: 1, unitPriceMinor: 50_000, itemId: String(mapped._id) }],
    } as never, { all: true });

    await settle();
    const before = await LmsProvision.countDocuments({});
    // It needs no approval, so approving is refused — which is itself the
    // point: this invoice never passes through the step that provisions.
    await post(`/invoices/${own.id}/approval/approve`, undefined, token);
    await settle();
    const after = await LmsProvision.countDocuments({});
    check("an invoice raised in finance never reaches the LMS", after === before, `${after - before} queued`);
    const stranger = await lms.db!.collection("users").findOne({ email: "direct@e2e-test.com" });
    check("...and no student is created for it", !stranger, "a student was created");
  }
  {
    // Mapped to nothing: recorded, not guessed at.
    const inv = await crmEnrolment("crm-3", String(unmapped._id), "unmapped@e2e-test.com", "Unmapped Student");
    await post(`/invoices/${inv.invoiceId}/approval/approve`, undefined, token);
    await settle();
    const row = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(inv.invoiceId) }).lean();
    check("an unmapped course is not sent", row?.status === "unmapped", `status=${row?.status}`);
    // Both halves, because there are two ways to know the course now and the
    // message has to say that neither of them did.
    check(
      "...and says what is missing",
      /no lms course/i.test(row?.lastError ?? "") && /enrolment named none/i.test(row?.lastError ?? ""),
      `"${row?.lastError}"`,
    );
    const nobody = await lms.db!.collection("users").findOne({ email: "unmapped@e2e-test.com" });
    check("...so nobody is enrolled on a guess", !nobody, "a student was created anyway");
  }

  // ── The mapping arriving from the CRM ─────────────────────────────────────
  step("Learning the mapping from the sales system");
  {
    const { Item } = await import("../modules/inventory/item.model");
    const fresh = await Item.create({
      organizationId: org._id, itemNumber: "ITM-0003", name: "Digital Marketing", sku: "DM",
      type: "service", trackStock: false, sellingPriceMinor: 130_000,
    });
    check("an item starts unmapped", !fresh.lmsCourseSlug, `slug=${fresh.lmsCourseSlug}`);

    const { intakeEnrolment } = await import("../modules/integrations/enrolment-intake.service");
    await intakeEnrolment(orgId, {
      externalId: "crm-learn", source: "crm",
      customer: { name: "Learner", email: "learner@e2e-test.com", phone: "+971500000001" },
      course: { name: "Digital Marketing", itemId: String(fresh._id), amountMinor: 130_000,
                lmsCourseSlug: "market-break-out-trading-program" },
      enrolledOn: today, declaredPaidMinor: 0, modeOfStudy: "online", language: "English",
    } as never);

    const learned = await Item.findById(fresh._id).lean<{ lmsCourseSlug?: string } | null>();
    check("...and learns its course from the enrolment", learned?.lmsCourseSlug === "market-break-out-trading-program",
      `slug=${learned?.lmsCourseSlug}`);

    // Finance's own answer was set deliberately; sales must not move it.
    await intakeEnrolment(orgId, {
      externalId: "crm-overwrite", source: "crm",
      customer: { name: "Learner Two", email: "learner2@e2e-test.com", phone: "+971500000002" },
      course: { name: "Digital Marketing", itemId: String(fresh._id), amountMinor: 130_000,
                lmsCourseSlug: "some-other-course" },
      enrolledOn: today, declaredPaidMinor: 0, modeOfStudy: "online", language: "English",
    } as never);
    const after = await Item.findById(fresh._id).lean<{ lmsCourseSlug?: string } | null>();
    check("...but a later one cannot move it", after?.lmsCourseSlug === "market-break-out-trading-program",
      `slug=${after?.lmsCourseSlug}`);
  }

  // ── The door itself ───────────────────────────────────────────────────────
  step("Refusing callers who are not finance");
  {
    const url = `${process.env.LMS_API_URL}/api/v1/integrations/finance/enrolment`;
    const body = JSON.stringify({
      email: "intruder@e2e-test.com", courseSlug: "market-break-out-trading-program",
      invoiceId: "forged-1",
    });

    const none = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
    check("no secret is refused", none.status === 401, `got ${none.status}`);

    const wrong = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-finance-secret": "not-the-secret" },
      body,
    });
    check("a wrong secret is refused", wrong.status === 401, `got ${wrong.status}`);

    const intruder = await lms.db!.collection("users").findOne({ email: "intruder@e2e-test.com" });
    check("...and no student is created either way", !intruder, "a student was created");

    // A slug nobody has: the caller's mistake, and it will not come right by
    // retrying, so it must not be treated as a transient failure.
    const unknown = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-finance-secret": process.env.LMS_S2S_SECRET! },
      body: JSON.stringify({ email: "ghost@e2e-test.com", courseSlug: "no-such-course", invoiceId: "ghost-1" }),
    });
    check("an unknown course is refused as permanent, not retried", unknown.status === 422, `got ${unknown.status}`);
  }

  // ── Paid in part: half the course ─────────────────────────────────────────
  step("Paid in part opens half the course; paying the balance opens the rest");
  {
    const { drainLmsAccessUpdates } = await import("../jobs/lms-provision.worker");
    const { intakeEnrolment } = await import("../modules/integrations/enrolment-intake.service");
    const now = () => new Date();
    const courseWith = async (slug: string, title: string, modules: number) => {
      const c = await lms.db!.collection("courses").insertOne({
        title, slug, organizationId: lmsOrg.insertedId, price: 4500, isPublished: true, createdAt: now(), updatedAt: now(),
      });
      const ids: string[] = [];
      for (let i = 0; i < modules; i++) {
        const s = await lms.db!.collection("sections").insertOne({
          courseId: c.insertedId, title: `Module ${i + 1}`, description: "", order: i, createdAt: now(), updatedAt: now(),
        });
        ids.push(String(s.insertedId));
      }
      return { id: c.insertedId, modules: ids };
    };
    const dwt = await courseWith("delta-wave-theory-trading-programme", "DELTA WAVE THEORY TRADING PROGRAMME", 10);
    const odd = await courseWith("seven-module-course", "SEVEN MODULE COURSE", 7);
    const dwtItem = await Item.create({
      organizationId: org._id, itemNumber: "ITM-0103", name: "Delta Wave Theory Trading Programme", sku: "DWTP",
      type: "service", trackStock: false, sellingPriceMinor: 450_000, lmsCourseSlug: "delta-wave-theory-trading-programme",
    });
    const oddItem = await Item.create({
      organizationId: org._id, itemNumber: "ITM-0104", name: "Seven Module Course", sku: "SMC",
      type: "service", trackStock: false, sellingPriceMinor: 450_000, lmsCourseSlug: "seven-module-course",
    });

    const enrol = (externalId: string, itemId: string, email: string, name: string, declaredPaidMinor: number) =>
      intakeEnrolment(orgId, {
        externalId, source: "crm",
        customer: { name, email, phone: "+971500000000" },
        course: { name, itemId, amountMinor: 450_000 },
        enrolledOn: today, declaredPaidMinor,
        modeOfStudy: "online", language: "English",
      } as never);
    const approveAndSend = async (invoiceId: string) => {
      await post(`/invoices/${invoiceId}/approval/approve`, undefined, token);
      await settle();
      await drainLmsProvisions();
    };
    const pay = (invoiceId: string, amountMinor: number) =>
      post(`/invoices/${invoiceId}/payments`, { method: "bank_transfer", amountMinor, paidOn: today }, token);
    // Raw rows from the LMS database: typed loosely on purpose.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const enrolmentOf = async (email: string, courseId: unknown): Promise<any> => {
      const u = await lms.db!.collection("users").findOne({ email });
      return u ? lms.db!.collection("enrollments").findOne({ userId: u._id, courseId }) : null;
    };
    const locked = (e: { blockedLessons?: unknown[] } | null) => (e?.blockedLessons ?? []).map(String).sort().join(",");
    const lockedOf = (ids: string[]) => [...ids].sort().join(",");

    // Ananya pays AED 2,000 of 4,500 at the close.
    const ananya = await enrol("crm-part-1", String(dwtItem._id), "ananya@e2e-test.com", "Ananya", 200_000);
    await post(`/invoices/${ananya.invoiceId}/approval/approve`, undefined, token);
    await settle();
    const queued = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(ananya.invoiceId) }).lean();
    check("a part-paid enrolment is handed over as partial",
      (queued?.payload as { paymentStatus?: string })?.paymentStatus === "partial", JSON.stringify(queued?.payload));
    await drainLmsProvisions();
    let e = await enrolmentOf("ananya@e2e-test.com", dwt.id);
    check("modules 1–5 open, 6–10 locked", locked(e) === lockedOf(dwt.modules.slice(5)), `locked ${(e?.blockedLessons ?? []).length}`);
    check("...and the enrolment says partial", (e as { paymentAccess?: { status?: string } } | null)?.paymentAccess?.status === "partial");

    // Accounts record the AED 2,000 she paid: still partial, nothing to send.
    const first = await pay(ananya.invoiceId, 200_000);
    check("accounts record her first payment", first.status === 200 || first.status === 201, `${first.status} ${JSON.stringify(first.body).slice(0, 200)}`);
    await settle();
    check("...which changes nothing in the LMS", (await drainLmsAccessUpdates()) === 0);

    // Then the AED 2,500 balance: paid in full.
    const balance = await pay(ananya.invoiceId, 250_000);
    check("accounts record the balance", balance.status === 200 || balance.status === 201, `${balance.status}`);
    await settle();
    check("the update goes to the LMS", (await drainLmsAccessUpdates()) === 1);
    e = await enrolmentOf("ananya@e2e-test.com", dwt.id);
    check("every module is open now", locked(e) === "", `still locked ${(e?.blockedLessons ?? []).length}`);
    check("...and the enrolment says paid", (e as { paymentAccess?: { status?: string } } | null)?.paymentAccess?.status === "paid");
    const row = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(ananya.invoiceId) }).lean();
    check("finance records that the LMS was told", (row as { access?: { sent?: string; pending?: string } } | null)?.access?.sent === "paid"
      && !(row as { access?: { pending?: string } } | null)?.access?.pending);

    // Taking a payment back never locks anything again.
    const inv = await (await import("../modules/invoice/invoice.model")).Invoice.findById(ananya.invoiceId).lean();
    const lastPayment = (inv?.payments as unknown as { _id: unknown }[] | undefined)?.at(-1)?._id;
    await request("DELETE", `/invoices/${ananya.invoiceId}/payments/${String(lastPayment)}`, undefined, token);
    await settle();
    await drainLmsAccessUpdates();
    e = await enrolmentOf("ananya@e2e-test.com", dwt.id);
    check("a payment deleted afterwards locks nothing again", locked(e) === "");

    // Rahul pays in full at the close.
    const rahul = await enrol("crm-full-1", String(dwtItem._id), "rahul@e2e-test.com", "Rahul", 450_000);
    await approveAndSend(rahul.invoiceId);
    e = await enrolmentOf("rahul@e2e-test.com", dwt.id);
    check("paid in full at the close: all 10 open", Boolean(e) && locked(e) === "");

    // Sara is approved with nothing paid yet.
    const sara = await enrol("crm-none-1", String(dwtItem._id), "sara@e2e-test.com", "Sara", 0);
    await approveAndSend(sara.invoiceId);
    e = await enrolmentOf("sara@e2e-test.com", dwt.id);
    check("nothing paid: a login, but no module open", Boolean(e) && locked(e) === lockedOf(dwt.modules));
    await pay(sara.invoiceId, 100_000);
    await settle();
    await drainLmsAccessUpdates();
    e = await enrolmentOf("sara@e2e-test.com", dwt.id);
    check("her first payment opens half", locked(e) === lockedOf(dwt.modules.slice(5)), `locked ${(e?.blockedLessons ?? []).length}`);

    // An odd number of modules rounds up.
    const omar = await enrol("crm-odd-1", String(oddItem._id), "omar@e2e-test.com", "Omar", 100_000);
    await approveAndSend(omar.invoiceId);
    e = await enrolmentOf("omar@e2e-test.com", odd.id);
    check("7 modules, partial: modules 1–4 open, 5–7 locked", locked(e) === lockedOf(odd.modules.slice(4)), `locked ${(e?.blockedLessons ?? []).length}`);

    // Somebody already on the course keeps exactly what they have.
    const existingUser = await lms.db!.collection("users").insertOne({
      email: "already@e2e-test.com", name: "Already Enrolled", role: "student", enrollmentStatus: "approved",
      organizationId: lmsOrg.insertedId, isActive: true, createdAt: now(), updatedAt: now(),
    });
    await lms.db!.collection("enrollments").insertOne({
      userId: existingUser.insertedId, courseId: dwt.id, status: "active", source: "admin", progressPercent: 0,
      blockedLessons: [], enrolledAt: now(), createdAt: now(), updatedAt: now(),
    });
    const already = await enrol("crm-existing-1", String(dwtItem._id), "already@e2e-test.com", "Already Enrolled", 100_000);
    await approveAndSend(already.invoiceId);
    e = await enrolmentOf("already@e2e-test.com", dwt.id);
    check("already enrolled before: nothing locked", locked(e) === "");
    check("...and not put under the payment rule", !(e as { paymentAccess?: { status?: string } } | null)?.paymentAccess?.status);

    // The follow-up door is finance's alone.
    const accessUrl = `${process.env.LMS_API_URL}/api/v1/integrations/finance/enrolment/access`;
    const wrongSecret = await fetch(accessUrl, {
      method: "POST", headers: { "content-type": "application/json", "x-finance-secret": "not-the-secret" },
      body: JSON.stringify({ invoiceId: sara.invoiceId, paymentStatus: "paid" }),
    });
    check("an access update with the wrong secret is refused", wrongSecret.status === 401, `got ${wrongSecret.status}`);
    const unknownInvoice = await fetch(accessUrl, {
      method: "POST", headers: { "content-type": "application/json", "x-finance-secret": process.env.LMS_S2S_SECRET! },
      body: JSON.stringify({ invoiceId: "no-such-invoice", paymentStatus: "paid" }),
    });
    check("an invoice the LMS never saw is a 404, not retried", unknownInvoice.status === 404, `got ${unknownInvoice.status}`);
    e = await enrolmentOf("sara@e2e-test.com", dwt.id);
    check("...and neither changed anybody's access", locked(e) === lockedOf(dwt.modules.slice(5)));
  }

  // ── Every course a sale opens ─────────────────────────────────────────────
  step("Every course a sale opens: a bundle, a second course, and Draw's enrolments");
  {
    const { drainLmsExtraCourses, drainLmsAccessUpdates } = await import("../jobs/lms-provision.worker");
    const { intakeEnrolment } = await import("../modules/integrations/enrolment-intake.service");
    const { extraCourseKey } = await import("../modules/integrations/lms-provision.model");
    const { env } = await import("../config/env");
    const now = () => new Date();
    const MBT = "market-break-out-trading-program";
    const DWT = "delta-wave-theory-trading-programme";
    const HADC = "hadc-heikin-ashi-decisive-candle";
    await lms.db!.collection("courses").insertOne({
      title: "HADC - HEIKIN ASHI DECISIVE CANDLE", slug: HADC, organizationId: lmsOrg.insertedId,
      price: 1000, isPublished: true, createdAt: now(), updatedAt: now(),
    });
    const courseId = async (slug: string) => (await lms.db!.collection("courses").findOne({ slug }))!._id;

    // Draw's bundle: one product to sell, two courses to study.
    const bundle = await Item.create({
      organizationId: org._id, itemNumber: "ITM-0201", name: "MBT + DWT (with credit)", sku: "DRAW-C2-WC",
      type: "service", trackStock: false, sellingPriceMinor: 550_000,
      lmsCourseSlug: MBT, lmsCourseSlugs: [MBT, DWT],
    });
    // A product nobody here has mapped — Draw's CRM names its course.
    const addOn = await Item.create({
      organizationId: org._id, itemNumber: "ITM-0202", name: "HADC add-on", sku: "DRAW-HADC",
      type: "service", trackStock: false, sellingPriceMinor: 100_000,
    });

    const draw = await intakeEnrolment(orgId, {
      externalId: "draw-1", source: "draw-crm",
      customer: { name: "Priya Draw", email: "priya.draw@e2e-test.com", phone: "+971500000001" },
      courses: [
        { name: "COURSE 2 - MBT + DWT (WITH CREDIT)", itemId: String(bundle._id), amountMinor: 550_000, lmsCourseSlug: MBT, lmsCourseSlugs: [MBT, DWT] },
        { name: "HADC add-on", itemId: String(addOn._id), amountMinor: 100_000, lmsCourseSlug: HADC },
      ],
      enrolledOn: today, declaredPaidMinor: 100_000,
      modeOfStudy: "online", language: "English",
      crm: "draw",
    } as never);
    const taught = await Item.findById(addOn._id).lean<{ lmsCourseSlug?: string; lmsCourseSlugs?: string[] }>();
    check("an unmapped product learns its course from the enrolment", taught?.lmsCourseSlug === HADC
      && JSON.stringify(taught?.lmsCourseSlugs) === JSON.stringify([HADC]), JSON.stringify(taught));

    // Tetra Commission switched on for this part: Delta's students go on to it, and since 2026-10-03 Draw's too.
    const saved = { url: env.COMMISSION_API_URL, secret: env.COMMISSION_S2S_SECRET };
    env.COMMISSION_API_URL = "http://127.0.0.1:1";
    env.COMMISSION_S2S_SECRET = "e2e-not-sent";
    const delta = await crmEnrolment("crm-commission-1", String(mapped._id), "delta.student@e2e-test.com", "Delta Student");
    for (const id of [draw.invoiceId, delta.invoiceId]) await post(`/invoices/${id}/approval/approve`, undefined, token);
    await settle();

    const queued = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(draw.invoiceId) }).lean();
    check("a Draw enrolment is queued for the LMS", queued?.status === "pending" && (queued as { source?: string })?.source === "draw-crm",
      `status=${queued?.status} source=${(queued as { source?: string })?.source}`);
    check("...its first course the bundle's first", (queued?.payload as { courseSlug?: string })?.courseSlug === MBT);
    check("...and the others after it, each once",
      JSON.stringify((queued?.extraCourses ?? []).map((e) => e.slug)) === JSON.stringify([DWT, HADC]),
      JSON.stringify(queued?.extraCourses));
    check("...carrying the CRM that sold it, for the LMS to tag", (queued?.payload as { crm?: string })?.crm === "draw",
      JSON.stringify((queued?.payload as { crm?: string })?.crm));

    await drainLmsProvisions();
    env.COMMISSION_API_URL = saved.url;
    env.COMMISSION_S2S_SECRET = saved.secret;
    const drawRow = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(draw.invoiceId) }).lean();
    const deltaRow = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(delta.invoiceId) }).lean();
    check("Delta's student goes on to Tetra Commission, as before", deltaRow?.commission?.state === "pending");
    check("Case 2 — Delta's, from a CRM that said nothing, is tagged the Sales CRM's by its source",
      (deltaRow?.payload as { crm?: string })?.crm === "delta", JSON.stringify((deltaRow?.payload as { crm?: string })?.crm));
    check("...and so does Draw's, its Forex course the same as Delta's", drawRow?.status === "sent" && drawRow?.commission?.state === "pending",
      JSON.stringify(drawRow?.commission));

    const extras = await drainLmsExtraCourses();
    check("the worker opens the other two courses", extras === 2, `${extras} opened`);
    const student = await lms.db!.collection("users").findOne({ email: "priya.draw@e2e-test.com" });
    const on = (await lms.db!.collection("enrollments").find({ userId: student?._id }).toArray()).map((e) => String(e.courseId));
    check("the student is on all three courses",
      [MBT, DWT, HADC].every(Boolean) && (await Promise.all([MBT, DWT, HADC].map(courseId))).every((id) => on.includes(String(id))),
      `enrolled on ${on.length}`);
    const orders = await lms.db!.collection("orders").find({
      "externalRef.id": { $in: [draw.invoiceId, extraCourseKey(draw.invoiceId, DWT), extraCourseKey(draw.invoiceId, HADC)] },
    }).toArray();
    const amountOf = (key: string) => orders.find((o) => o.externalRef?.id === key)?.amount;
    // 650,000 fils, the invoice's total, in minor units — once the whole-unit
    // bug was fixed; it used to be stored as 6500 and shown as AED 65.00.
    check("one order per course, each under its own key; the sale's total is counted once",
      orders.length === 3 && amountOf(draw.invoiceId) === 650_000
        && amountOf(extraCourseKey(draw.invoiceId, DWT)) === 0 && amountOf(extraCourseKey(draw.invoiceId, HADC)) === 0,
      JSON.stringify(orders.map((o) => [o.externalRef?.id, o.amount])));
    const feeOn = async (slug: string) =>
      (await lms.db!.collection("enrollments").findOne({ userId: student?._id, courseId: await courseId(slug) }))?.feeSummary as { feeMinor?: number } | undefined;
    check("Case 2 — the sale's fee summary is on the first course only, not repeated on the courses it also opens",
      (await feeOn(MBT))?.feeMinor === 650_000 && !(await feeOn(DWT)) && !(await feeOn(HADC)),
      JSON.stringify([await feeOn(MBT), await feeOn(DWT), await feeOn(HADC)]));
    const crmOn = async (slug: string) =>
      (await lms.db!.collection("enrollments").findOne({ userId: student?._id, courseId: await courseId(slug) }))?.salesCrm as string | undefined;
    check("Case 1 — but every course it opens is tagged with the CRM that sold it",
      (await crmOn(MBT)) === "draw" && (await crmOn(DWT)) === "draw" && (await crmOn(HADC)) === "draw",
      JSON.stringify([await crmOn(MBT), await crmOn(DWT), await crmOn(HADC)]));
    const dwtEnrolment = async () => lms.db!.collection("enrollments").findOne({ userId: student?._id, courseId: await courseId(DWT) });
    check("the second course follows the payment rule too: part paid, half open",
      (await dwtEnrolment() as { paymentAccess?: { status?: string } } | null)?.paymentAccess?.status === "partial");
    check("drained again, nothing is sent twice", (await drainLmsExtraCourses()) === 0);

    // Paying the balance opens every course the sale bought, not only the first.
    const paid = await post(`/invoices/${draw.invoiceId}/payments`, { method: "bank_transfer", amountMinor: 650_000, paidOn: today }, token);
    check("accounts record the payment", paid.status === 200 || paid.status === 201, `${paid.status}`);
    await settle();
    await drainLmsAccessUpdates();
    check("...and every course opens in full, the further ones too",
      (await dwtEnrolment() as { paymentAccess?: { status?: string } } | null)?.paymentAccess?.status === "paid");
    const after = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(draw.invoiceId) }).lean();
    check("finance records that each was told",
      after?.access?.sent === "paid" && (after?.extraCourses ?? []).every((e) => e.accessSent === "paid"),
      JSON.stringify(after?.extraCourses?.map((e) => [e.slug, e.accessSent])));
  }

  step("The Banglore CRM: to the LMS as a Bangalore student, never to Tetra Commission");
  {
    const { intakeEnrolment } = await import("../modules/integrations/enrolment-intake.service");
    const { env } = await import("../config/env");
    const blrOrg = await lms.db!.collection("organizations").insertOne({
      name: "Delta Bangalore", slug: "bangalore", currency: "INR", createdAt: new Date(), updatedAt: new Date(),
    });
    const saved = { url: env.COMMISSION_API_URL, secret: env.COMMISSION_S2S_SECRET };
    env.COMMISSION_API_URL = "http://127.0.0.1:1";
    env.COMMISSION_S2S_SECRET = "e2e-not-sent";
    const blr = await intakeEnrolment(orgId, {
      externalId: "blr-1", source: "crm", crm: "banglore",
      customer: { name: "Kiran Blr", email: "kiran.blr@e2e-test.com", phone: "+919800000002" },
      course: { name: "Market Break out", itemId: String(mapped._id), amountMinor: 130_000 },
      enrolledOn: today, declaredPaidMinor: 0, modeOfStudy: "online", language: "English",
    } as never);
    await post(`/invoices/${blr.invoiceId}/approval/approve`, undefined, token);
    await settle();
    const queued = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(blr.invoiceId) }).lean();
    check("a Banglore close is queued for the LMS, carrying crm \"banglore\"",
      queued?.status === "pending" && (queued?.payload as { crm?: string })?.crm === "banglore", JSON.stringify({ s: queued?.status, crm: (queued?.payload as { crm?: string })?.crm }));
    await drainLmsProvisions();
    env.COMMISSION_API_URL = saved.url;
    env.COMMISSION_S2S_SECRET = saved.secret;
    const sent = await LmsProvision.findOne({ invoiceId: new Types.ObjectId(blr.invoiceId) }).lean();
    check("...taken by the LMS, on its Forex course, and passed over for Tetra Commission",
      sent?.status === "sent" && sent?.lmsCourseProgram === "4x-trading" && sent?.commission?.state === "skipped" && /Banglore/.test(sent?.commission?.reason ?? ""),
      JSON.stringify({ s: sent?.status, c: sent?.commission }));
    const u = await lms.db!.collection("users").findOne({ email: "kiran.blr@e2e-test.com" });
    check("...a new LMS student in the Bangalore organisation, though Dubai runs the course",
      String(u?.organizationId) === String(blrOrg.insertedId), String(u?.organizationId));
    const e = u ? await lms.db!.collection("enrollments").findOne({ userId: u._id }) : null;
    check("...the enrolment tagged the Banglore CRM", e?.salesCrm === "banglore", JSON.stringify(e?.salesCrm));
  }

  await lms.close();
  await mongoose.disconnect();
  console.log("");
  if (failures) { console.log(`\x1b[31m${failures} of ${checks} checks failed\x1b[0m`); process.exit(1); }
  console.log(`\x1b[32mAll ${checks} checks passed\x1b[0m`);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
