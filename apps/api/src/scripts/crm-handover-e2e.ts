/**
 * Drives a lead closing in the CRM all the way to an invoice in finance, over
 * the signed HTTP the two systems actually use, against a real API process.
 *
 * It exists because this path had never once executed. The CRM's own database
 * credentials do not authenticate, so no real lead-close has ever reached
 * finance — and the first time this was run end to end it turned up a bug that
 * would have failed every single handover: the CRM sends no language, the
 * inbound schema accepts the empty string, and the Invoice model refuses it.
 * Typechecks and unit tests on pure functions cannot find that. Only running it
 * can.
 *
 * Three sections, in the order a sale moves through them:
 *
 *   A. Who a sale can be attributed to — the Super Admin grant and the
 *      escalation guard around it, since an organization administrator holding
 *      the wildcard permission must not be able to reach other organizations.
 *   B. Whether the salesperson can be found — the login realignment script,
 *      over drift the production data happened not to contain.
 *   C. The handover itself — signing, attribution, tax, approval, idempotency,
 *      and a client buying a second course.
 *
 * Run through scripts/crm-handover-e2e.sh, which stands up a throwaway mongod
 * and a throwaway API and tears both down again. This refuses to run against
 * anything that does not look like a scratch database.
 */
import crypto from "node:crypto";
import path from "node:path";
import mongoose, { Types } from "mongoose";
import { SYSTEM_ROLES } from "@delta/shared";
import { hashPassword } from "../lib/password";
import { Organization } from "../modules/organization/organization.model";
import { Role } from "../modules/role/role.model";
import { User } from "../modules/user/user.model";
import { Employee } from "../modules/employee/employee.model";
import { Invoice } from "../modules/invoice/invoice.model";
import { Customer } from "../modules/customer/customer.model";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

const PORT = process.env.E2E_API_PORT ?? "4100";
const ORIGIN = `http://127.0.0.1:${PORT}`;
const BASE = `${ORIGIN}/api/v1`;
const INBOUND_ID = process.env.INBOUND_CLIENT_ID ?? "";
const INBOUND_SECRET = process.env.INBOUND_INTEGRATION_SECRET ?? "";
if (!INBOUND_ID || !INBOUND_SECRET) {
  console.error("Refusing to run: INBOUND_CLIENT_ID and INBOUND_INTEGRATION_SECRET must be set");
  process.exit(1);
}

/** The password every fixture account shares. Local, throwaway, never a secret. */
const PASSWORD = "E2ePassword1!";
const HRMS_ORG = "hrms-e2e";

let failures = 0;
let checks = 0;

function check(label: string, condition: boolean, detail = "") {
  checks++;
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures++;
    console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  }
}

function step(name: string) {
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

type Res = { status: number; body: Record<string, never> };
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 200)}`;

async function post(path: string, body: unknown, token?: string): Promise<Res> {
  return request("POST", path, body, token);
}

async function request(method: string, p: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, never> };
}

async function login(email: string): Promise<{ token: string; id: string }> {
  const r = await post("/auth/login", { email, password: PASSWORD });
  const data = r.body?.data as unknown as { accessToken?: string; user?: { id: string } } | undefined;
  if (!data?.accessToken) throw new Error(`login failed for ${email}: ${show(r)}`);
  return { token: data.accessToken, id: data.user?.id ?? "" };
}

/**
 * Byte-for-byte what the CRM's financeClient sends. Rebuilt here rather than
 * imported so that a change to the signing on either side shows up as a failure
 * instead of quietly agreeing with itself.
 */
async function signedPost(orgId: string, p: string, payload: unknown): Promise<Res> {
  const raw = JSON.stringify(payload);
  const ts = String(Date.now());
  const nonce = crypto.randomUUID();
  const canonical = [
    "POST",
    p,
    ts,
    nonce,
    crypto.createHash("sha256").update(raw).digest("hex"),
  ].join("\n");
  const r = await fetch(`${ORIGIN}${p}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-delta-client": INBOUND_ID,
      "x-delta-timestamp": ts,
      "x-delta-nonce": nonce,
      "x-delta-signature": crypto.createHmac("sha256", INBOUND_SECRET).update(canonical).digest("hex"),
      "x-delta-org": orgId,
    },
    body: raw,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, never> };
}

/** Runs a repo script the way an operator would, and returns everything it said. */
async function runScript(file: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", path.join(import.meta.dir, file), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return out + err;
}

async function main() {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();

  // ── Fixtures ─────────────────────────────────────────────────────────────
  step("Setting up an organization");
  const org = await Organization.create({
    name: "Delta HQ",
    baseCurrency: "AED",
    // Delta HQ bills VAT. Without this the tax assertion below would be
    // checking an empty configuration and passing for the wrong reason.
    taxRates: [{ label: "VAT 5%", code: "VAT", rate: 5, isDefault: true, appliesTo: "sales" }],
  });
  const orgId = String(org._id);

  for (const def of SYSTEM_ROLES) {
    await Role.create({
      organizationId: org._id,
      key: def.key,
      name: def.name,
      description: def.description,
      permissions: def.permissions,
      isSystem: true,
    });
  }
  const roles = await Role.find({ organizationId: org._id }).lean();
  const roleId = (key: string) => String(roles.find((r) => r.key === key)!._id);
  const passwordHash = await hashPassword(PASSWORD);

  // An organization administrator: the wildcard permission, and nothing above
  // this organization. The account the escalation guard exists to constrain.
  const admin = await User.create({
    name: "Org Admin",
    email: "admin@e2e-test.com",
    passwordHash,
    status: "active",
    memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(roleId("admin")), status: "active" }],
  });
  // A platform super admin who is also a member here, so the org-scoped user
  // routes can see them. One who belongs to no organization answers 404 there,
  // which is a different thing from being refused.
  await User.create({
    name: "Platform Super",
    email: "super@e2e-test.com",
    passwordHash,
    isSuperAdmin: true,
    status: "active",
    memberships: [{ organizationId: org._id, roleId: new Types.ObjectId(roleId("admin")), status: "active" }],
  });
  console.log(`  organization ${orgId}, ${roles.length} roles, 2 accounts`);

  const adminAuth = await login("admin@e2e-test.com");
  const superAuth = await login("super@e2e-test.com");

  // ── A. Who a sale can be attributed to ───────────────────────────────────
  step("A. The Super Admin grant, and the guard around it");

  const escalate = await post(
    "/users",
    {
      name: "Escalation Attempt",
      email: "escalate@e2e-test.com",
      password: PASSWORD,
      roleId: roleId("admin"),
      isSuperAdmin: true,
    },
    adminAuth.token,
  );
  check("an organization administrator cannot create a super admin", escalate.status === 403, show(escalate));
  check(
    "...and nothing was written for the refused request",
    (await User.countDocuments({ email: "escalate@e2e-test.com" })) === 0,
  );

  const made = await post(
    "/users",
    {
      name: "New Super",
      email: "newsuper@e2e-test.com",
      password: PASSWORD,
      roleId: roleId("admin"),
      isSuperAdmin: true,
    },
    superAuth.token,
  );
  check("a super admin can create one", made.status === 201, show(made));
  const newSuper = made.body?.data as unknown as { id: string; isSuperAdmin: boolean } | undefined;
  check("the response reports the flag, so the screen can label it", newSuper?.isSuperAdmin === true);
  check(
    "the flag is on the record itself",
    (await User.findOne({ email: "newsuper@e2e-test.com" }).lean())?.isSuperAdmin === true,
  );

  const plain = await post(
    "/users",
    { name: "Plain Sales", email: "sales@e2e-test.com", password: PASSWORD, roleId: roleId("salesperson") },
    superAuth.token,
  );
  const plainUser = plain.body?.data as unknown as { id: string; isSuperAdmin: boolean } | undefined;
  check("an ordinary user is created without it", plain.status === 201 && plainUser?.isSuperAdmin === false, show(plain));

  const listed = await request("GET", "/users?pageSize=100", undefined, superAuth.token);
  const rows = (listed.body?.data ?? []) as unknown as { id: string; isSuperAdmin: boolean }[];
  check("the list carries the flag", rows.find((u) => u.id === newSuper!.id)?.isSuperAdmin === true);

  const rename = await request("PATCH", `/users/${newSuper!.id}`, { name: "New Super Renamed" }, adminAuth.token);
  check("an administrator may still edit a super admin's other fields", rename.status === 200, show(rename));

  // The form sends the whole record back. Echoing a field you may not change is
  // not an attempt to change it, and must not be refused.
  const echo = await request(
    "PATCH",
    `/users/${newSuper!.id}`,
    { name: "New Super Renamed", isSuperAdmin: true },
    adminAuth.token,
  );
  check("echoing the value it already holds is not an escalation", echo.status === 200, show(echo));

  const promote = await request("PATCH", `/users/${plainUser!.id}`, { isSuperAdmin: true }, adminAuth.token);
  check("an administrator cannot promote somebody", promote.status === 403, show(promote));
  check(
    "...and the refused promotion did not land",
    (await User.findOne({ email: "sales@e2e-test.com" }).lean())?.isSuperAdmin !== true,
  );

  const strip = await request("PATCH", `/users/${newSuper!.id}`, { isSuperAdmin: false }, adminAuth.token);
  check("an administrator cannot demote one either", strip.status === 403, show(strip));

  const asNewSuper = await login("newsuper@e2e-test.com");
  const selfDemote = await request("PATCH", `/users/${newSuper!.id}`, { isSuperAdmin: false }, asNewSuper.token);
  check("a super admin cannot strip their own flag", selfDemote.status === 409, show(selfDemote));
  check(
    "...and still holds it",
    (await User.findOne({ email: "newsuper@e2e-test.com" }).lean())?.isSuperAdmin === true,
  );

  const demote = await request("PATCH", `/users/${newSuper!.id}`, { isSuperAdmin: false }, superAuth.token);
  check("a super admin can demote somebody else", demote.status === 200, show(demote));
  check(
    "...and it landed",
    (await User.findOne({ email: "newsuper@e2e-test.com" }).lean())?.isSuperAdmin === false,
  );

  // ── B. Whether the salesperson can be found ──────────────────────────────
  step("B. Realigning logins that drifted from HRMS");

  const employee = async (
    code: string,
    name: string,
    hrmsEmail: string,
    loginEmail: string,
    opts: { lastLoginAt?: Date } = {},
  ) => {
    const u = await User.create({
      name,
      email: loginEmail,
      passwordHash,
      status: "active",
      lastLoginAt: opts.lastLoginAt ?? null,
      memberships: [
        { organizationId: org._id, roleId: new Types.ObjectId(roleId("salesperson")), status: "active" },
      ],
    });
    await Employee.create({
      organizationId: org._id,
      hrmsOrgId: HRMS_ORG,
      hrmsEmployeeId: code,
      employeeCode: code,
      name,
      email: hrmsEmail,
      userId: u._id,
      status: "active",
    });
    return u;
  };

  // The ordinary case: HRMS corrected the address, the login never followed.
  await employee("T001", "Drift One", "driftone@e2e-test.com", "drift1@e2e-test.com");
  // Has signed in, so the old address is a credential actually in use.
  await employee("T002", "Drift Two", "drifttwo@e2e-test.com", "drift2@e2e-test.com", { lastLoginAt: new Date() });
  // The target belongs to somebody else. Merging two people is not a rename.
  await User.create({ name: "Squatter", email: "taken@e2e-test.com", passwordHash, status: "active", memberships: [] });
  await employee("T003", "Drift Three", "taken@e2e-test.com", "drift3@e2e-test.com");
  // Held back by name, for the case finance cannot see: the CRM still points at
  // the current address, so moving it would break what this is meant to repair.
  await employee("T004", "Drift Four", "driftfour@e2e-test.com", "drift4@e2e-test.com");
  // Already correct. Must be neither touched nor counted.
  await employee("T005", "Aligned", "aligned@e2e-test.com", "aligned@e2e-test.com");

  const dry = await runScript("realign-payroll-logins.ts", "--skip=T004");
  check("a dry run reports the one that should move", /Would move \(1\)/.test(dry), dry.slice(-300));
  check("a dry run writes nothing", (await User.countDocuments({ email: "drift1@e2e-test.com" })) === 1);

  const applied = await runScript("realign-payroll-logins.ts", "--apply", "--skip=T004");
  check("applying moves exactly one", /Done\. 1 login\(s\) realigned/.test(applied), applied.slice(-300));
  check("the drifted login now answers to the HRMS address", (await User.countDocuments({ email: "driftone@e2e-test.com" })) === 1);
  check("...and no longer to the old one", (await User.countDocuments({ email: "drift1@e2e-test.com" })) === 0);
  check("somebody who has signed in is left alone", (await User.countDocuments({ email: "drift2@e2e-test.com" })) === 1);
  check("a target that belongs to another account is left alone", (await User.countDocuments({ email: "drift3@e2e-test.com" })) === 1);
  check("--skip is honoured", (await User.countDocuments({ email: "drift4@e2e-test.com" })) === 1);
  check("the account holding the target is not overwritten", (await User.findOne({ email: "taken@e2e-test.com" }).lean())?.name === "Squatter");

  const again = await runScript("realign-payroll-logins.ts", "--apply", "--skip=T004");
  check("running it a second time changes nothing", /Done\. 0 login\(s\) realigned/.test(again), again.slice(-200));

  // ── C. The handover ──────────────────────────────────────────────────────
  step("C. A closed lead becomes an invoice");

  const enrolment = (externalId: string, salespersonEmail: string, customerName = "E2E Student") => ({
    externalId,
    source: "crm",
    customer: { name: customerName, email: `${externalId}@student-e2e.com`, phone: "+971500000000" },
    course: { name: "E2E Course", amountMinor: 130_000 },
    salespersonEmail,
    salespersonName: "Drift One",
    enrolledOn: new Date().toISOString().slice(0, 10),
    declaredPaidMinor: 0,
    modeOfStudy: "online" as const,
    // Exactly what the CRM sends: it has no language field.
    language: "",
  });

  const unsigned = await fetch(`${ORIGIN}/api/v1/integrations/ping`);
  check("an unsigned call is refused", unsigned.status === 401, String(unsigned.status));

  const first = await signedPost(orgId, "/api/v1/integrations/enrolments", enrolment("e2e-1", "driftone@e2e-test.com"));
  check("a signed enrolment is accepted", first.status === 200, show(first));

  const inv1 = await Invoice.findOne({ "external.externalId": "e2e-1" }).lean();
  check("an invoice was created", !!inv1);
  const driftOne = await User.findOne({ email: "driftone@e2e-test.com" }).lean();
  check(
    "it is attributed to the realigned salesperson, not the fallback approver",
    String(inv1?.salespersonId) === String(driftOne?._id),
    `salespersonId=${inv1?.salespersonId}`,
  );
  const flags = (inv1?.external as { flags?: string[] } | undefined)?.flags ?? [];
  check("no attribution flag was raised", !flags.some((f) => /no account/i.test(f)), JSON.stringify(flags));
  // The fee the CRM sends is what the client agreed to pay: 1,300 stays 1,300,
  // and the VAT comes out of it rather than being added on top.
  check(
    "the agreed fee is the total, with tax taken out of it",
    inv1?.totalMinor === 130_000,
    `totalMinor=${inv1?.totalMinor}`,
  );
  const net = inv1?.subtotalMinor ?? 0;
  const vat = inv1?.taxTotalMinor ?? 0;
  check(
    "...and the tax was still charged, out of that figure",
    vat > 0 && net + vat === inv1?.totalMinor,
    `subtotal=${net} tax=${vat} total=${inv1?.totalMinor}`,
  );
  check("it starts pending, so it cannot reach the client unapproved", inv1?.approval?.state === "pending", JSON.stringify(inv1?.approval));
  // The bug this whole script was written to catch.
  check(
    "the language the CRM never sends still yields a valid enrolment",
    inv1?.enrolment?.language === "Not specified",
    `language=${inv1?.enrolment?.language}`,
  );

  const retry = await signedPost(orgId, "/api/v1/integrations/enrolments", enrolment("e2e-1", "driftone@e2e-test.com"));
  check("a retry after a timeout is idempotent", retry.status === 200, show(retry));
  check("...and bills the client once", (await Invoice.countDocuments({ "external.externalId": "e2e-1" })) === 1);

  const unknown = await signedPost(
    orgId,
    "/api/v1/integrations/enrolments",
    enrolment("e2e-2", "nobody@e2e-test.com", "Second Student"),
  );
  check("an unknown salesperson does not block the sale", unknown.status === 200, show(unknown));
  const inv2 = await Invoice.findOne({ "external.externalId": "e2e-2" }).lean();
  const flags2 = (inv2?.external as { flags?: string[] } | undefined)?.flags ?? [];
  check("...the invoice still exists", !!inv2);
  check("...and is flagged for somebody to reassign", flags2.some((f) => /no account/i.test(f)), JSON.stringify(flags2));

  // The counter-example: the address the CRM would have used before section B.
  const stale = await signedPost(
    orgId,
    "/api/v1/integrations/enrolments",
    enrolment("e2e-3", "drift1@e2e-test.com", "Third Student"),
  );
  const inv3 = await Invoice.findOne({ "external.externalId": "e2e-3" }).lean();
  const flags3 = (inv3?.external as { flags?: string[] } | undefined)?.flags ?? [];
  check(
    "the pre-realignment address falls back, which is what made the fix necessary",
    stale.status === 200 && flags3.some((f) => /no account/i.test(f)),
    JSON.stringify(flags3),
  );

  const secondCourse = {
    ...enrolment("e2e-4", "driftone@e2e-test.com"),
    customer: { name: "E2E Student", email: "e2e-1@student-e2e.com", phone: "+971500000000" },
    course: { name: "Second Course", amountMinor: 50_000 },
  };
  const again2 = await signedPost(orgId, "/api/v1/integrations/enrolments", secondCourse);
  check("the same client can buy a second course", again2.status === 200, show(again2));
  check(
    "...without being duplicated as a customer",
    (await Customer.countDocuments({ email: "e2e-1@student-e2e.com" })) === 1,
  );

  console.log(
    failures
      ? `\n\x1b[31m${failures} of ${checks} checks failed\x1b[0m`
      : `\n\x1b[32mAll ${checks} checks passed\x1b[0m`,
  );
  await mongoose.disconnect();
  process.exit(failures ? 1 : 0);
}

main().catch(async (err) => {
  console.error("\nHarness error:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(2);
});
