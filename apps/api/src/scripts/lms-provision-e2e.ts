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
